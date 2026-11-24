# Tooling & Integrations

- Prefers AI features to run on free-tier model providers (no billing/paid cards required); chooses free quotas over paid keys. Confidence: 0.8
- Wants model providers to automatically switch/fail over between models and across providers so the app "always works" instead of hard-failing when one model is rate-limited or unavailable. Confidence: 0.8
- Wants API keys for providers configurable from the app's own settings UI (with server env vars only as a fallback), not env-only configuration. Confidence: 0.65
- Deploys apps through Google AI Studio and re-publishes them there, so changes must stay compatible with AI Studio's runtime secret/env injection and be usable right after republish. Confidence: 0.65
