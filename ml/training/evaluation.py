"""Model evaluation: metrics, calibration, feature importance, artifact saving."""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    auc,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)

from ml.config import ARTIFACTS_DIR


def evaluate_model(model, X_val, y_val):
    """Compute classification metrics on the validation set."""
    y_prob = model.predict_proba(X_val)[:, 1]
    y_pred = (y_prob >= 0.5).astype(int)

    precision_curve, recall_curve, thresholds = precision_recall_curve(y_val, y_prob)
    auc_pr = auc(recall_curve, precision_curve)

    f1_scores = []
    for p, r in zip(precision_curve[:-1], recall_curve[:-1]):
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
        f1_scores.append(f1)

    best_idx = int(np.argmax(f1_scores))
    optimal_threshold = float(thresholds[best_idx])
    y_pred_optimal = (y_prob >= optimal_threshold).astype(int)

    n_positive = int(y_val.sum())
    n_negative = int(len(y_val) - n_positive)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dataset_size": len(y_val),
        "positive_count": n_positive,
        "negative_count": n_negative,
        "conversion_rate": round(n_positive / len(y_val), 4) if len(y_val) > 0 else 0,
        "auc_roc": round(float(roc_auc_score(y_val, y_prob)), 4),
        "auc_pr": round(float(auc_pr), 4),
        "log_loss": round(float(log_loss(y_val, y_prob)), 4),
        "threshold_default": {
            "value": 0.5,
            "precision": round(float(precision_score(y_val, y_pred, zero_division=0)), 4),
            "recall": round(float(recall_score(y_val, y_pred, zero_division=0)), 4),
            "f1": round(float(f1_score(y_val, y_pred, zero_division=0)), 4),
        },
        "threshold_optimal": {
            "value": round(optimal_threshold, 4),
            "precision": round(float(precision_score(y_val, y_pred_optimal, zero_division=0)), 4),
            "recall": round(float(recall_score(y_val, y_pred_optimal, zero_division=0)), 4),
            "f1": round(float(f1_score(y_val, y_pred_optimal, zero_division=0)), 4),
        },
        "confusion_matrix_default": confusion_matrix(y_val, y_pred).tolist(),
        "confusion_matrix_optimal": confusion_matrix(y_val, y_pred_optimal).tolist(),
    }


def calibrate_model(model, X_val, y_val):
    """Fit an isotonic regression calibrator on validation predictions.

    CatBoost outputs well-ranked probabilities (high AUC) but the raw scores
    may not be well-calibrated — i.e. a score of 0.7 may not correspond to a
    70% actual conversion rate. This matters for synthetic conversions: if we
    report a 70% predicted conversion to GA4/Metrika and only 20% actually
    convert, the ad platform's optimization loop degrades.

    Returns the fitted IsotonicRegression calibrator.
    """
    y_prob = model.predict_proba(X_val)[:, 1]
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(y_prob, y_val)
    return calibrator


def calibration_metrics(model, X_val, y_val, calibrator=None, n_bins=10):
    """Compute Expected Calibration Error and per-bin reliability data.

    Returns a dict with:
      - ece_raw: ECE before calibration
      - ece_calibrated: ECE after calibration (if calibrator provided)
      - bins: list of {confidence, accuracy, count} for reliability diagram
      - bins_calibrated: same after calibration
    """
    y_prob_raw = model.predict_proba(X_val)[:, 1]
    y_val_arr = np.array(y_val)

    def _ece_and_bins(probs):
        bin_edges = np.linspace(0, 1, n_bins + 1)
        ece = 0.0
        bins_out = []
        for i in range(n_bins):
            mask = (probs >= bin_edges[i]) & (probs < bin_edges[i + 1])
            count = int(mask.sum())
            if count == 0:
                continue
            bin_conf = float(probs[mask].mean())
            bin_acc = float(y_val_arr[mask].mean())
            ece += count * abs(bin_acc - bin_conf)
            bins_out.append({
                "confidence": round(bin_conf, 4),
                "accuracy": round(bin_acc, 4),
                "count": count,
            })
        return round(ece / len(probs), 4), bins_out

    ece_raw, bins_raw = _ece_and_bins(y_prob_raw)
    result = {"ece_raw": ece_raw, "bins": bins_raw}

    if calibrator is not None:
        y_prob_cal = calibrator.predict(y_prob_raw)
        ece_cal, bins_cal = _ece_and_bins(y_prob_cal)
        result["ece_calibrated"] = ece_cal
        result["bins_calibrated"] = bins_cal

    return result


def get_feature_importance(model, feature_names):
    """Extract and sort feature importance from CatBoost model."""
    importances = model.get_feature_importance()
    items = [
        {"feature": name, "importance": round(float(imp), 2)}
        for name, imp in zip(feature_names, importances)
    ]
    items.sort(key=lambda x: x["importance"], reverse=True)
    return items


def print_report(metrics, importance, cal_metrics=None):
    """Print human-readable evaluation report."""
    print("\n" + "=" * 50)
    print("SURFAI Model Evaluation")
    print("=" * 50)
    print(
        f"Dataset: {metrics['dataset_size']} sessions "
        f"({metrics['positive_count']} converted, "
        f"{metrics['negative_count']} not converted)"
    )
    print(f"Conversion rate: {metrics['conversion_rate'] * 100:.1f}%")

    print(f"\nAUC-ROC:  {metrics['auc_roc']}")
    print(f"AUC-PR:   {metrics['auc_pr']}")
    print(f"Log Loss: {metrics['log_loss']}")

    td = metrics["threshold_default"]
    print(f"\nAt threshold {td['value']}:")
    print(f"  Precision: {td['precision']}")
    print(f"  Recall:    {td['recall']}")
    print(f"  F1:        {td['f1']}")

    to = metrics["threshold_optimal"]
    print(f"\nAt optimal threshold {to['value']}:")
    print(f"  Precision: {to['precision']}")
    print(f"  Recall:    {to['recall']}")
    print(f"  F1:        {to['f1']}")

    cm = metrics["confusion_matrix_optimal"]
    print(f"\nConfusion Matrix (optimal threshold):")
    print(f"              Pred 0    Pred 1")
    print(f"  Actual 0    {cm[0][0]:>6}    {cm[0][1]:>6}")
    print(f"  Actual 1    {cm[1][0]:>6}    {cm[1][1]:>6}")

    if cal_metrics:
        print(f"\nCalibration (ECE — lower is better, 0 = perfect):")
        print(f"  Before calibration: {cal_metrics['ece_raw']}")
        if "ece_calibrated" in cal_metrics:
            print(f"  After  calibration: {cal_metrics['ece_calibrated']}")

    print(f"\nTop 10 Features:")
    for i, item in enumerate(importance[:10], 1):
        print(f"  {i:>2}. {item['feature']:<40} {item['importance']:>6.1f}")

    print("=" * 50)


def save_artifacts(model, metrics, importance, calibrator=None, cal_metrics=None, output_dir=None):
    """Save model, calibrator, metrics, and importance to disk."""
    out = Path(output_dir) if output_dir else ARTIFACTS_DIR
    out.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    model_path = out / f"model_{ts}.cbm"
    metrics_path = out / f"metrics_{ts}.json"
    importance_path = out / f"importance_{ts}.json"
    latest_model_path = out / "latest_model.cbm"

    model.save_model(str(model_path))

    if cal_metrics:
        metrics["calibration"] = cal_metrics

    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)

    with open(importance_path, "w") as f:
        json.dump(importance, f, indent=2)

    shutil.copy2(model_path, latest_model_path)

    print(f"\nArtifacts saved to {out}/")
    print(f"  Model:      {model_path.name}")
    print(f"  Metrics:    {metrics_path.name}")
    print(f"  Importance: {importance_path.name}")

    if calibrator is not None:
        calibrator_path = out / f"calibrator_{ts}.pkl"
        latest_calibrator_path = out / "latest_calibrator.pkl"
        joblib.dump(calibrator, str(calibrator_path))
        joblib.dump(calibrator, str(latest_calibrator_path))
        print(f"  Calibrator: {calibrator_path.name}")
        print(f"  Latest cal: {latest_calibrator_path.name}")

    print(f"  Latest:     {latest_model_path.name}")

    return model_path, metrics_path, importance_path
