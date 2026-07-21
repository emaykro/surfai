#!/usr/bin/env bash
# SURFAI weekly ML retrain chain: k-means refit -> global+site retrain -> full rescore.
#
# Order matters: behavior_cluster is a categorical feature of the model, and
# k-means cluster ids are arbitrary — refitting centroids permutes them. So
# centroids must be refit (and every session relabelled) BEFORE the model
# trains, and the full rescore must run AFTER, so scores, cluster labels and
# model always agree.
#
# Site-model regression guard lives inside `ml train` (site_models.py): a site
# model is only deployed if site_auc >= global_auc - 0.005. The global model
# has no automated guard — a rollback copy of the previous model is kept as
# preretrain_<stamp>.cbm (last 3 retained). To roll back:
#   cp ml/artifacts/preretrain_<stamp>.cbm ml/artifacts/latest_model.cbm
#
# Env (DATABASE_URL etc.) comes from the systemd unit's EnvironmentFile.
set -euo pipefail

cd /opt/surfai

STAMP=$(date +%Y%m%d_%H%M)
if [ -f ml/artifacts/latest_model.cbm ]; then
  cp ml/artifacts/latest_model.cbm "ml/artifacts/preretrain_${STAMP}.cbm"
  # Keep only the 3 most recent rollback copies.
  ls -t ml/artifacts/preretrain_*.cbm 2>/dev/null | tail -n +4 | xargs -r rm --
fi

python3 -m ml cluster --all
python3 -m ml train
python3 -m ml score --all

echo "Retrain chain complete: $(date -Is)"
