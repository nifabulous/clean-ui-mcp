# Security Notes

## Create UI Spec Model Artifact Store

The proposal-only model path keeps generated history in a separate gitignored
store: `.create-ui-spec-model-artifacts/`.

Records in that store:

- persist until `ModelArtifactStore.delete(artifactId)` is called;
- are permanently removed by that delete operation;
- are not corpus data;
- are not retrieval input;
- are not readable through `create_ui_spec`.

This store exists to retain validated proposal metadata without promoting model
output into `corpus/entries.json`, `corpus/decisions.json`, or any corpus
reader/ranking path.
