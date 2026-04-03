"""CLI entry point for SURFAI ML training pipeline."""

import argparse
import sys

from sklearn.model_selection import train_test_split

from ml.config import MIN_POSITIVE_SAMPLES, RANDOM_SEED, TEST_SIZE


def cmd_train(args):
    from ml.data.preprocessing import prepare_features
    from ml.training.evaluation import (
        evaluate_model,
        get_feature_importance,
        print_report,
        save_artifacts,
    )
    from ml.training.trainer import train_model

    # Load data
    if args.synthetic:
        from ml.data.synthetic import generate_synthetic_sessions

        print("[synthetic mode] Generating 500 synthetic sessions for smoke test...")
        df = generate_synthetic_sessions(n=500)
    else:
        from ml.data.loader import load_session_features

        df = load_session_features(
            min_event_count=args.min_events,
            target_column=args.target,
        )

    if len(df) == 0:
        print("ERROR: No data loaded. Nothing to train on.")
        sys.exit(1)

    n_positive = df[args.target].sum()
    print(f"Total sessions: {len(df)}, converted: {n_positive}")

    if n_positive < MIN_POSITIVE_SAMPLES:
        print(
            f"ERROR: Only {n_positive} positive samples found. "
            f"Need at least {MIN_POSITIVE_SAMPLES} to train a meaningful model. "
            f"Collect more conversion data before training."
        )
        sys.exit(1)

    # Preprocess
    X, y, feature_names, cat_indices = prepare_features(df, target_column=args.target)
    print(f"Features: {len(feature_names)} ({len(cat_indices)} categorical)")

    # Split
    X_train, X_val, y_train, y_val = train_test_split(
        X, y,
        test_size=TEST_SIZE,
        random_state=RANDOM_SEED,
        stratify=y,
    )
    print(f"Train: {len(X_train)} | Val: {len(X_val)}")

    # Train
    model = train_model(X_train, y_train, X_val, y_val, cat_indices, feature_names)

    # Evaluate
    metrics = evaluate_model(model, X_val, y_val)
    importance = get_feature_importance(model, feature_names)
    metrics["catboost_params"] = model.get_all_params()
    metrics["target_column"] = args.target
    metrics["min_events_filter"] = args.min_events

    print_report(metrics, importance)
    save_artifacts(model, metrics, importance, args.output_dir)


def cmd_evaluate(args):
    from catboost import CatBoostClassifier

    from ml.data.preprocessing import prepare_features
    from ml.training.evaluation import (
        evaluate_model,
        get_feature_importance,
        print_report,
    )

    model = CatBoostClassifier()
    model.load_model(args.model)
    print(f"Loaded model from {args.model}")

    if args.synthetic:
        from ml.data.synthetic import generate_synthetic_sessions

        df = generate_synthetic_sessions(n=500)
    else:
        from ml.data.loader import load_session_features

        df = load_session_features(min_event_count=args.min_events)

    X, y, feature_names, cat_indices = prepare_features(df)
    metrics = evaluate_model(model, X, y)
    importance = get_feature_importance(model, feature_names)
    print_report(metrics, importance)


def cmd_generate_synthetic(args):
    from ml.data.synthetic import generate_synthetic_sessions

    df = generate_synthetic_sessions(n=args.n)
    print(f"Generated {len(df)} synthetic sessions")
    print(f"  Converted: {df['converted'].sum()} ({df['converted'].mean() * 100:.1f}%)")

    if args.output:
        df.to_csv(args.output, index=False)
        print(f"  Saved to {args.output}")
    else:
        print("  Use --output path.csv to save")


def main():
    parser = argparse.ArgumentParser(description="SURFAI ML Training Pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    # train
    p_train = sub.add_parser("train", help="Train a CatBoost model")
    p_train.add_argument("--synthetic", action="store_true", help="Use synthetic data")
    p_train.add_argument("--min-events", type=int, default=10, help="Min events per session")
    p_train.add_argument("--target", default="converted", help="Target column")
    p_train.add_argument("--output-dir", default=None, help="Artifacts output dir")

    # evaluate
    p_eval = sub.add_parser("evaluate", help="Evaluate a trained model")
    p_eval.add_argument("--model", required=True, help="Path to .cbm model")
    p_eval.add_argument("--synthetic", action="store_true", help="Use synthetic data")
    p_eval.add_argument("--min-events", type=int, default=10)

    # generate-synthetic
    p_gen = sub.add_parser("generate-synthetic", help="Generate synthetic test data")
    p_gen.add_argument("--n", type=int, default=500, help="Number of sessions")
    p_gen.add_argument("--output", default=None, help="Output CSV path")

    args = parser.parse_args()

    if args.command == "train":
        cmd_train(args)
    elif args.command == "evaluate":
        cmd_evaluate(args)
    elif args.command == "generate-synthetic":
        cmd_generate_synthetic(args)
