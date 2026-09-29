# Apify deployment

## Commercial settings

Configure the Actor as Pay Per Event with these events:

| Event | Store price |
|---|---:|
| `company-basic` | USD 0.03 |
| `company-reputation` | USD 0.15 |
| `business-risk` | USD 0.25 |

Set `company-reputation` as the primary event. The code calls the official `Actor.charge({ eventName, count: 1 })` API after a successful Rafid analysis and before publishing its dataset item. A partial charge caused by `maxTotalChargeUsd` is rejected and is not published as a success.

Do not enable platform-usage passthrough when targeting agentic-payment eligibility. Use limited permissions, do not enable Standby, and do not require the caller's Apify token. Complete developer KYC where Apify requires it for supported agentic-payment eligibility.

## Secrets and configuration

Pass the same provider environment variables used by Rafid. Review the root `.env.example` for the current list; common examples include provider API keys and optional database URLs. Never commit or print secrets. No Apify token is required for normal platform execution.

## Build and deploy

From the repository root (the root `.actor/actor.json` supplies the repository build context):

```powershell
npm.cmd install
cd apify/company-intelligence
npm.cmd install
npm.cmd run typecheck
npm.cmd test
cd ../..
apify push --version 1.0 --build-tag latest
```

If using Git integration, push the repository branch and let Apify build the Actor from `apify/company-intelligence/Dockerfile` with the repository root as build context.

## Store publication

1. Create or select the Actor slug `global-company-intelligence`.
2. Build version `1.0` and run a non-production test with `company_basic`.
3. Configure the three PPE events and prices above; verify the event names exactly.
4. Add the Store title, short description, README, input/output schemas and dataset schema from this directory.
5. Add only the provider secrets required for the Rafid providers you intend to enable.
6. Run single, batch and invalid-input tests; inspect Dataset and `OUTPUT`.
7. Publish to Store after reviewing actual runtime/provider costs and the limitations disclosure.

## Local run

The automated adapter tests use mocked charging and service boundaries. A real Apify CLI run requires the CLI and configured provider environment; never use live PPE for automated tests.
