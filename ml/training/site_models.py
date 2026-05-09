"""Per-site fine-tuned CatBoost models (Phase 7).

For each graduated site (>= MIN_SITE_CONVERSIONS real conversions), fine-tune
a site-specific model initialized from the global model. A site model is saved
only when it beats the global model on the site's own validation slice.

See vault/decisions/2026-05-10 phase 7 hierarchical ml.md for the rationale.
"""

import logging

import joblib
from catboost import CatBoostClassifier, Pool
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split

from ml.config import (
    ARTIFACTS_DIR,
    CATBOOST_PARAMS,
    MIN_SITE_CONVERSIONS,
    RANDOM_SEED,
    TEST_SIZE,
)
from ml.data.preprocessing import prepare_features

log = logging.getLogger(__name__)

# Fine-tuning is a nudge, not a retrain. Lower LR + iteration cap keeps the
# site model anchored to the global weights when site data is scarce.
SITE_FINE_TUNE_PARAMS = {
    "iterations": 200,
    "learning_rate": 0.02,
    "early_stopping_rounds": 30,
}

# Don't deploy a site model whose AUC is within this epsilon of global —
# below noise floor, not worth the routing complexity.
DEPLOY_AUC_EPSILON = 0.005

# Need at least this many positives in the per-site VAL slice to evaluate
# AUC meaningfully. Two positives is the absolute floor for any AUC at all.
MIN_VAL_POSITIVES = 4


def _site_artifact_paths(site_id):
    return (
        ARTIFACTS_DIR / f"site_{site_id}_model.cbm",
        ARTIFACTS_DIR / f"site_{site_id}_calibrator.pkl",
    )


def _safe_auc(y_true, y_prob):
    if len(set(y_true)) < 2:
        return None
    return float(roc_auc_score(y_true, y_prob))


def train_site_models(global_model, df, target_column="converted"):
    """Fine-tune one CatBoost model per graduated site, evaluate vs global, save winners.

    Args:
        global_model: the freshly-trained global CatBoostClassifier.
        df: the same dataframe that was used to train the global model
            (raw, pre-prepare_features). Must contain `site_id` and target.
        target_column: name of the binary target column.

    Returns:
        list[dict] with one entry per graduated site:
            site_id, conv_count, n_train, n_val, global_auc, site_auc, deployed (bool), reason
    """
    if "site_id" not in df.columns:
        log.warning("df has no site_id column — skipping per-site training")
        return []

    conv_per_site = df.groupby("site_id")[target_column].sum()
    graduated = conv_per_site[conv_per_site >= MIN_SITE_CONVERSIONS].index.tolist()

    if not graduated:
        log.info("No graduated sites (>= %d conversions) — skipping per-site training",
                 MIN_SITE_CONVERSIONS)
        return []

    log.info("Per-site fine-tuning for %d graduated site(s): %s",
             len(graduated), ", ".join(str(s) for s in graduated))

    results = []
    for site_id in graduated:
        result = _train_one_site(global_model, df, site_id, target_column)
        results.append(result)

    return results


def _train_one_site(global_model, df, site_id, target_column):
    site_df = df[df["site_id"] == site_id].copy()
    conv_count = int(site_df[target_column].sum())
    n_total = len(site_df)

    base = {
        "site_id": str(site_id),
        "conv_count": conv_count,
        "n_train": 0,
        "n_val": 0,
        "global_auc": None,
        "site_auc": None,
        "deployed": False,
        "reason": "",
    }

    # prepare_features handles JSONB expansion + boolean cast + cat fill;
    # we run it on the per-site slice so column order matches the global model.
    X, y, feature_names, cat_indices = prepare_features(site_df, target_column=target_column)

    # Need both classes for stratified split + AUC.
    if y.sum() < MIN_VAL_POSITIVES * 2 or (len(y) - y.sum()) < MIN_VAL_POSITIVES * 2:
        base["reason"] = f"too few of one class for split (pos={int(y.sum())}, neg={int(len(y) - y.sum())})"
        log.info("site %s: skip — %s", site_id, base["reason"])
        return base

    X_train, X_val, y_train, y_val = train_test_split(
        X, y,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
        stratify=y,
    )
    base["n_train"] = len(X_train)
    base["n_val"] = len(X_val)

    if y_val.sum() < MIN_VAL_POSITIVES:
        base["reason"] = f"val slice has only {int(y_val.sum())} positives (need >= {MIN_VAL_POSITIVES})"
        log.info("site %s: skip — %s", site_id, base["reason"])
        return base

    # 1) Global model's AUC on this site's val — the bar to beat.
    global_prob = global_model.predict_proba(X_val)[:, 1]
    base["global_auc"] = _safe_auc(y_val.tolist(), global_prob)

    # 2) Fine-tune from global on this site's train slice.
    train_pool = Pool(X_train, label=y_train, cat_features=cat_indices, feature_names=feature_names)
    val_pool = Pool(X_val, label=y_val, cat_features=cat_indices, feature_names=feature_names)

    site_params = {**CATBOOST_PARAMS, **SITE_FINE_TUNE_PARAMS, "verbose": 0}
    site_model = CatBoostClassifier(**site_params)
    site_model.fit(train_pool, eval_set=val_pool, init_model=global_model, use_best_model=True)

    site_prob = site_model.predict_proba(X_val)[:, 1]
    base["site_auc"] = _safe_auc(y_val.tolist(), site_prob)

    # 3) Deploy decision.
    if base["global_auc"] is None or base["site_auc"] is None:
        base["reason"] = "AUC undefined (single-class slice)"
        log.info("site %s: skip — %s", site_id, base["reason"])
        return base

    if base["site_auc"] < base["global_auc"] - DEPLOY_AUC_EPSILON:
        base["reason"] = (
            f"site AUC {base['site_auc']:.4f} < global {base['global_auc']:.4f} "
            f"(epsilon {DEPLOY_AUC_EPSILON}) — keep global"
        )
        log.info("site %s: skip — %s", site_id, base["reason"])
        # Clean up any stale artifact from a previous training pass — the site
        # has regressed and must not keep serving an old fine-tune.
        model_path, cal_path = _site_artifact_paths(site_id)
        for p in (model_path, cal_path):
            if p.exists():
                p.unlink()
                log.info("site %s: removed stale artifact %s", site_id, p.name)
        return base

    # 4) Calibrate per-site (small slice, but matches the model's distribution
    # better than the global calibrator would).
    site_calibrator = IsotonicRegression(out_of_bounds="clip")
    site_calibrator.fit(site_prob, y_val)

    model_path, cal_path = _site_artifact_paths(site_id)
    site_model.save_model(str(model_path))
    joblib.dump(site_calibrator, str(cal_path))

    base["deployed"] = True
    base["reason"] = "deployed"
    log.info(
        "site %s: deployed (site AUC %.4f vs global %.4f, +%.4f, n_train=%d, n_val=%d)",
        site_id, base["site_auc"], base["global_auc"],
        base["site_auc"] - base["global_auc"], base["n_train"], base["n_val"],
    )
    return base


def print_site_summary(results):
    if not results:
        print("\nPer-site fine-tuning: no graduated sites.")
        return

    print("\n" + "=" * 70)
    print("Per-site fine-tuning summary")
    print("=" * 70)
    print(f"{'site_id':<40} {'conv':>5} {'global':>7} {'site':>7} {'delta':>8} {'status':<10}")
    for r in results:
        g = f"{r['global_auc']:.4f}" if r["global_auc"] is not None else "  n/a "
        s = f"{r['site_auc']:.4f}" if r["site_auc"] is not None else "  n/a "
        if r["global_auc"] is not None and r["site_auc"] is not None:
            d = f"{r['site_auc'] - r['global_auc']:+.4f}"
        else:
            d = "   n/a "
        status = "deployed" if r["deployed"] else "skipped"
        print(f"{r['site_id']:<40} {r['conv_count']:>5} {g:>7} {s:>7} {d:>8} {status:<10}")
        if not r["deployed"] and r["reason"]:
            print(f"  reason: {r['reason']}")
    print("=" * 70)
