"""Model evaluation: metrics, feature importance, reporting, artifact saving."""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
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

    # AUC-PR with optimal threshold
    precision_curve, recall_curve, thresholds = precision_recall_curve(y_val, y_prob)
    auc_pr = auc(recall_curve, precision_curve)

    # Optimal threshold: maximize F1 on PR curve
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


def get_feature_importance(model, feature_names):
    """Extract and sort feature importance from CatBoost model."""
    importances = model.get_feature_importance()
    items = [
        {"feature": name, "importance": round(float(imp), 2)}
        for name, imp in zip(feature_names, importances)
    ]
    items.sort(key=lambda x: x["importance"], reverse=True)
    return items


def print_report(metrics, importance):
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

    print(f"\nTop 10 Features:")
    for i, item in enumerate(importance[:10], 1):
        print(f"  {i:>2}. {item['feature']:<40} {item['importance']:>6.1f}")

    print("=" * 50)


def save_artifacts(model, metrics, importance, output_dir=None):
    """Save model, metrics, and importance to disk."""
    out = Path(output_dir) if output_dir else ARTIFACTS_DIR
    out.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    model_path = out / f"model_{ts}.cbm"
    metrics_path = out / f"metrics_{ts}.json"
    importance_path = out / f"importance_{ts}.json"
    latest_model_path = out / "latest_model.cbm"

    model.save_model(str(model_path))

    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)

    with open(importance_path, "w") as f:
        json.dump(importance, f, indent=2)

    shutil.copy2(model_path, latest_model_path)

    print(f"\nArtifacts saved to {out}/")
    print(f"  Model:      {model_path.name}")
    print(f"  Metrics:    {metrics_path.name}")
    print(f"  Importance: {importance_path.name}")
    print(f"  Latest:     {latest_model_path.name}")

    return model_path, metrics_path, importance_path
