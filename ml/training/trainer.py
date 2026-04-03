"""CatBoost training wrapper."""

from catboost import CatBoostClassifier, Pool

from ml.config import CATBOOST_PARAMS


def train_model(X_train, y_train, X_val, y_val, cat_indices, feature_names, params=None):
    """Train a CatBoost classifier with early stopping on validation set.

    Returns the fitted model.
    """
    final_params = {**CATBOOST_PARAMS}
    if params:
        final_params.update(params)

    train_pool = Pool(
        X_train,
        label=y_train,
        cat_features=cat_indices,
        feature_names=feature_names,
    )
    val_pool = Pool(
        X_val,
        label=y_val,
        cat_features=cat_indices,
        feature_names=feature_names,
    )

    model = CatBoostClassifier(**final_params)
    model.fit(train_pool, eval_set=val_pool, use_best_model=True)

    return model
