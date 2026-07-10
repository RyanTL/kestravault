# Setup — What You Must Do Manually

Things an AI agent can't (or shouldn't) do for you — accounts, payments, secrets, external services. Grouped by when you need them.

## Needed now (to start Phase 0)
- [ ] **GitHub repo.** Create it (private to start). _I can `git init` here, scaffold, and make the first commit on request; you (or I, with your OK if `gh` is authed) create the remote:_ `gh repo create kestravault --private --source . --push`.
- [ ] **Anthropic API access.** Create/confirm an org + API key in the Console, and confirm **Managed Agents (beta)** access. _Account + key creation is manual._
- [ ] **Supabase project.** Create one (free tier is fine for beta). _I can help create/configure it via tooling with your confirmation, or you do it in the dashboard._ You'll need the project URL + keys.
- [ ] **Local toolchain.** Node 20+, pnpm. For desktop builds: platform build tools. For mobile: Xcode / Android Studio + Expo tooling. _Installing on your machine is manual._

## Needed soon (private beta → mobile)
- [ ] **Apple Developer Program** (~$99/yr) — iOS on real devices / TestFlight.
- [ ] **Google Play Developer** (~$25 one-time) — Android distribution.
- [ ] **Expo / EAS account** — mobile builds (free tier to start).

## Needed at/after MVP launch
- [ ] **Stripe account** — billing, quotas, paid plan.
- [ ] **Domain name** — _I can check availability/pricing; you purchase._
- [ ] **AWS account** — only if/when migrating off managed Supabase (open question O10).
- [ ] **App Store / Play listings**, privacy policy, terms of service.

## Secrets handling (from day one)
- All keys in `.env.local` (gitignored). Never commit secrets.
- CI/backend secrets go in the provider's secret store (GitHub Actions secrets, Supabase env).
- Agents read keys from env only — never hardcode.

## Who does what
- **I can:** scaffold the repo, write code/specs, design screens, set up CI, write migrations; and *with your confirmation* — create/configure the Supabase project, `git init` + first commit + `gh repo create`, check domain availability.
- **Only you can:** create and pay for accounts (GitHub, Anthropic, Supabase, Apple, Google, Stripe, AWS) and hold the credentials.
