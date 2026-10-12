# Unihood

A campus social app for finding **people, groups and events**, built with Expo
SDK 57, TypeScript and Expo Router on a paper-toned "Campus Editorial" design
system - on top of a **self-hosted API** (Node.js + Express + MySQL 8) in this
same repository.

The Supabase project is gone. Accounts, profiles, interests, locations, nearby
discovery **and groups** are served by `backend/`, which owns the MySQL schema, the
password hashing and every privacy rule; the mobile app talks to it over HTTP and
holds nothing but an access token. Accounts, profiles, interests, locations, nearby
discovery, groups **and events** are all database-backed - the in-app mock
catalogues are gone.

---

## What is live

### Accounts, profiles and discovery - the API

| Route | File | What it does |
| --- | --- | --- |
| `/setup-required` | `app/setup-required.tsx` | Shown instead of everything else when no API URL is configured |
| `/welcome` | `app/(auth)/welcome.tsx` | Signed-out landing: what the app is, and the one way in |
| `/sign-in` | `app/(auth)/sign-in.tsx` | Phone number + password, on one screen that also creates the account — and no third door: there is no code path left in the app |
| `/onboarding` | `app/onboarding.tsx` | First run, in three saved steps: name + optional gender, interests, nearby setup |
| `/profile/edit` | `app/profile/edit.tsx` | The same fields, reachable again later, plus the location card |

Phase 5 replaced email + password with a phone number, and the credential in front
of that number is a password again: `/sign-up`, `/verify-email`,
`/forgot-password`, `/reset-password` and `/auth/callback` are still gone, because
`/sign-in` now carries both halves of the flow - signing in, and creating the
account in the first place. See
[Phone and password](#phone-and-password).


### The app itself

| Route | File | What it does |
| --- | --- | --- |
| `/` | `app/(tabs)/index.tsx` | **People** - the nearby search: Name / Skill segments (Skill suggests from the whole catalogue), radius + interest + match chips, paged results |
| `/groups` | `app/(tabs)/groups.tsx` | **Groups** - Nearby / All groups / My groups over the API: search, category chips, radius |
| `/events` | `app/(tabs)/events.tsx` | **Events** - one unified feed (*All upcoming / Needs response / Going / Not going*) of the calendar of the groups you are in, with search and category chips |
| `/profile` | `app/(tabs)/profile.tsx` | **Profile** - the stored row, interests, location sharing, your groups, RSVPs, sign out |
| `/person/[id]` | `app/person/[id].tsx` | Member detail, from `GET /api/people/:id` |
| `/group/[id]` | `app/group/[id].tsx` | Group detail, membership and the join / request / leave action |
| `/group/manage/[id]` | `app/group/manage/[id].tsx` | Owner and administrator tools: join requests, members, roles, removal |
| `/group/edit/[id]` | `app/group/edit/[id].tsx` | The owner's group settings, including archiving |
| `/group/chat/[id]` | `app/group/chat/[id].tsx` | The group's chat - live over Socket.IO, with HTTP history and a send that falls back to HTTP |
| `/event/[id]` | `app/event/[id].tsx` | Event detail, the Going / Not going answer and the guest list |
| `/event/edit/[id]` | `app/event/edit/[id].tsx` | The organiser's event settings, and cancelling |
| `/create/group` | `app/create/group.tsx` | The create-group form |
| `/create/event` | `app/create/event.tsx` | The create-event form (optionally `?groupId=` preselected) |
| `/profile/edit` | `app/profile/edit.tsx` | The profile editor, reached from the Profile tab (the onboarding form is its twin) |
| `/profile/change-password` | `app/profile/change-password.tsx` | Replacing the password: the current one, the new one twice, and what happens to the other devices |
| `/profile/delete-account` | `app/profile/delete-account.tsx` | Closing the account: what goes, the word `DELETE`, the password, and the one refusal that names a group |

Interactions that work across screens, because the tabs and the detail views read
the same state:

- **Edit profile** (or finish onboarding) and the change is on the Profile tab and
  in the next discovery request.
- **Share / replace / remove a nearby area** from Profile or the editor; nearby
  results follow it. Nothing expires on its own - the area stays until it is
  replaced, removed, or the account is closed - and withdrawing consent deletes
  the stored point in the same write.
- **Join / leave / request** a group; memberships are rows in MySQL, so they
  survive a restart, and the profile's "Your groups" section and the Groups tab
  read the same server rows.
- **Answer Going or Not going** to an event; the answer, the guest count and the
  profile's "Going to" section are all server rows. Withdrawing the answer returns
  the event to *Needs response*, while *Not going* stays a real answer.
- **Chat with a group** you are in; a message is a row in MySQL that survives a
  restart and arrives on the other members' screens over Socket.IO - and it is still
  there for a member whose socket never connected.
- **Sign out** anywhere returns the whole app to `/welcome`, and revokes the
  session server-side so the access token stops working immediately.
- **Change the password** from Profile: every other device is signed out and this
  one stays put, because a session opened with the old password is what a change is
  for. **Delete the account** from the same section: the API re-verifies the password,
  refuses while a group you own still has other members (naming them, so the screen
  can offer the way to `/groups`), then deletes the row and everything under it - so
  the app returns to `/welcome`, because the session went with the account.

## Session and routing

`app/_layout.tsx` is the whole session machine. `AuthProvider` owns the session
and the profile row; the root Stack then exposes exactly one of four sets of
screens, using `Stack.Protected`:

| State | Guard | Screens |
| --- | --- | --- |
| No backend configured | `!isConfigured` | `/setup-required` alone |
| Signed out | `!isSignedIn` | the `(auth)` stack |
| Signed in, profile unfinished | `isSignedIn && !profileCompleted` | `/onboarding` alone |
| Signed in, profile complete | `isSignedIn && profileCompleted` | the tabs and detail screens |

Two details worth knowing:

- **The launch screen waits for the profile row.** Fonts + session + profile is
  what decides between onboarding and the app, so a cold start with a stored
  session holds the splash until that row is in. The wait is bounded (5 s): after
  that the member is let through and the screen reports the failure and offers a
  retry, because a network that never answers must not trap anyone on a splash.
- **Signing in is a phone number and a password, and creating the account is the
  other half of the same screen.** A new member gives a name, a number and a
  password; the password is hashed, the number is claimed for that account, and the
  API signs them in and reports `onboardingRequired` so the guard above sends them
  through onboarding. A code path still exists on the API for one case only: an
  account created by a code before passwords existed, which has no password to type
  - the API answers `password_not_set` and the app shows that sentence as it is,
  because the honest answer is that whoever runs Unihood has to set a password on
  it. Nothing in the app creates an account through a code any more.

Phase 5 removed the auth deep links (`?verified=1`, `?mode=recovery&token=…`) and
the `AuthRouteWatcher` that moved a reset link onto `/reset-password`. The API's
browser landing pages (`/auth/verify-email`, `/auth/reset-password`) still exist
and still work for accounts created before this phase - they are simply not part
of the app's flow any more.

## Tech stack

- **Expo SDK 57** (`expo-router` ~57.0.25), file-based routing with
  `Stack.Protected` guards
- **React 19.2** / **React Native 0.86** - no third-party state or data library
- **Node.js 20+ / Express 4 / MySQL 8** for the API in `backend/`, with `mysql2`,
  `zod` (validation), `jsonwebtoken` (access tokens), `nodemailer` (email) and
  `express-rate-limit`
- **Node's own `crypto.scrypt`** for password hashing - no native build step
- **expo-location** for the single-shot, opt-in location fix
- **TypeScript** strict in both projects, **ESLint** via `eslint-config-expo`
- Fonts: **Fraunces** (headlines) + **Inter** (UI) through `@expo-google-fonts`
- Icons: `@expo/vector-icons` (Ionicons)

## Repository layout

```
unihood/
  app/                        # Expo Router file tree - screens and routing only
    _layout.tsx               # Providers, splash gate and the four guarded route sets
    setup-required.tsx        # Shown when EXPO_PUBLIC_API_BASE_URL is missing
    onboarding.tsx            # First-run flow: identity, interests, nearby
    (auth)/                   # The signed-out stack: welcome, sign-in
    (tabs)/                   # People, Groups, Events, Profile
    person/[id].tsx           # Member detail
    group/[id].tsx            # Group detail + membership
    group/manage/[id].tsx     # Join requests + member management
    group/edit/[id].tsx       # Owner settings + archiving
    group/chat/[id].tsx       # The group's chat: live thread + composer
    create/group.tsx          # Create a group
    create/event.tsx          # Create an event (always posted to one of your groups)
    profile/edit.tsx          # Profile editor + location card
    profile/change-password.tsx  # Replace the password (signs the other devices out)
    profile/delete-account.tsx   # Close the account: what goes, DELETE, and the password
  src/
    lib/                      # Framework-free helpers: env, apiClient, errors, geo, routes
    features/auth/            # AuthProvider, authApi (transport), deepLink, route watcher
    features/profile/         # profileRepo   - GET/PUT /api/profile/me
    features/people/          # peopleRepo    - GET /api/people, /api/people/:id
    features/location/        # locationRepo  - PUT/DELETE /api/location/me + sharing UI
    features/groups/          # groupRepo + the group form, card and location picker
    features/events/          # eventRepo + the event form, card and RSVP list
    features/chat/            # chatRepo (HTTP), chatSocket (Socket.IO), useGroupChat (state)
    data/interestsRepo.ts     # GET /api/interests (+ the offline fallback catalog)
    types/                    # Profile, Person, Interest, Group, Event, Chat
    components/ theme/ store/ # Shared UI, design tokens, local-only toggles
  backend/
    src/config/env.ts         # Every setting, validated once with zod
    src/db/                   # Pool (UTC-pinned), migration runner, connectivity check
    src/domain/geo.ts         # Radius bounds, rounding and the write throttle (the authority)
    src/domain/groups.ts      # Categories, audiences, membership states, eligibility rule
    src/domain/events.ts      # Event categories, statuses, RSVP states, field limits
    src/domain/chat.ts        # Path, event names, message limits, page size, sweep interval
    src/http/                 # Body/query validation and the JSON error envelope
    src/lib/                  # password (scrypt), tokens, mailer, redirects, errors
    src/middleware/           # requireAuth, rate limiting
    src/realtime/             # Socket.IO attachment (socket.ts) and room eviction (hub.ts)
    src/routes/               # auth, account, profile, interests, location, people, groups, events, health, links
    src/services/             # The only code that knows SQL
    src/tools/smoke.ts        # End-to-end behaviour test (npm run smoke)
    src/tools/resetData.ts    # Snapshot, verify, clear and restore local data (npm run db:reset)
    migrations/               # 0001..0012, applied by npm run db:migrate
    .env                      # Local configuration (git-ignored)
  zz-db-bootstrap.ps1         # Local MySQL bootstrap: schema, app user and backend/.env
```

## Getting started

Requires **Node 20+** (verified on Node 22.17 / npm 11) and **MySQL 8**.

- MySQL **8.0.35** is what this build was developed and tested against; MySQL 8 is
  a hard floor, because the schema uses `CHECK` constraints, spatial columns with
  SRID 0 and `INSERT ... ON DUPLICATE KEY UPDATE ... AS incoming`.
- `lower_case_table_names=1` is assumed where identifiers are lower-cased (the
  Windows default; a Linux server satisfies it either way).

### 1. The backend

```bash
cd backend
npm install

# First time only, on a machine with a local MySQL server: creates the `unihood`
# schema, the `unihood_app` user and backend/.env. Run from the repo root:
#   .\zz-db-bootstrap.ps1

npm run db:migrate     # applies migrations/0001..0012
npm run db:check       # server version, schema, UTC session, migration count
npm run db:reset:dry   # what is stored, and what a reset would remove (writes nothing)
npm run dev            # tsx watch src/server.ts -> http://localhost:4000
```

`npm run build && npm start` runs the compiled output (`dist/server.js`) instead.

Startup refuses to run against an unmigrated schema: `assertSchemaReady` checks
both the tables *and* the columns the API reads, so a missing migration is a clear
message at boot instead of a 500 on the first request.

If `npm run dev` stops with `EADDRINUSE: address already in use 0.0.0.0:4000`, a
server from an earlier run still owns the port. Note that `tsx watch` does *not* exit
when its child crashes, so an attempt that failed this way keeps watching and re-binds
the port on the next file save - stop that old terminal with Ctrl+C first, then clear
whatever is left listening (a detached or backgrounded run outlives its terminal):

```powershell
# Who holds it, then free it and confirm it is gone
Get-NetTCPConnection -LocalPort 4000 -State Listen |
  Select-Object LocalPort, OwningProcess
Get-NetTCPConnection -LocalPort 4000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Invoke-WebRequest http://127.0.0.1:4000/health    # 200 = exactly one server is up
```

Only one instance may serve the port: two of them would each answer half the requests,
which looks like random 401s and stale reads rather than an obvious failure.

### 2. The mobile app

```bash
npm install                # from the repository root
cp .env.example .env       # then set EXPO_PUBLIC_API_BASE_URL
npm start                  # scan the QR code with Expo Go
```

The API URL depends on where the app runs:

| Target | `EXPO_PUBLIC_API_BASE_URL` |
| --- | --- |
| Web preview, iOS simulator | `http://localhost:4000` |
| Android emulator | `http://10.0.2.2:4000` |
| Physical phone (Expo Go) | `http://<machine-LAN-IP>:4000`, e.g. `http://192.168.0.5:4000` |

On a physical phone `localhost` is the phone itself, so the LAN address is the
only one that works; both devices must be on the same network, and the backend
already listens on `0.0.0.0`. It prints the address it is listening on when it
starts.

Other entry points: `npm run android`, `npm run ios` (macOS + Xcode), `npm run web`.

Without a URL the app opens on `/setup-required`, which lists exactly what is
missing. That is deliberate: there is no pretend signed-in state and no mock
people to fall back on.

Expo inlines `EXPO_PUBLIC_*` at bundle time, so restart the dev server after
editing the file, and never put a server-only secret behind that prefix - anything
with it ends up in the shipped bundle.

## Configuration

### Mobile (`/.env`)

| Variable | Required | Notes |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | yes | The API's origin, no trailing slash. Missing -> `/setup-required` |
| `EXPO_PUBLIC_APP_ENV` | no | `development` \| `preview` \| `production`; shown on the setup screen |

### Backend (`/backend/.env`)

Every value is parsed and validated once, at startup, by `src/config/env.ts` -
a bad value is a clear error rather than a confusing failure later.

The values below are the ones `zz-db-bootstrap.ps1` writes into the development
`.env`. Where a variable is absent, `src/config/env.ts` falls back to its own,
stricter default - the per-IP rate limits fall back to `400` (general), `40` (auth)
and `30` (one-time codes) per window rather than the roomier development values - so
a bucket sized for a local smoke run never becomes the shipped default. The chat
write's per-member budget is the one value that does *not* move: `300` writes per 15
minutes is both the development setting and the fallback, because what it bounds is a
runaway client rather than a person typing.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` forces `EXPOSE_DEV_TOKENS` off |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `4000` | `0.0.0.0` is what lets a phone on the LAN connect |
| `API_PUBLIC_URL` | `http://localhost:4000` | Used to build the links inside emails |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | - | MySQL connection |
| `DB_CONNECTION_LIMIT` | `10` | Pool size |
| `JWT_ACCESS_SECRET` | - | HS256 signing key for access tokens; rotate by restarting with a new value (every session stays valid because sessions are checked in the database) |
| `ACCESS_TOKEN_TTL_MINUTES` | `15` | |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | |
| `MAX_ACTIVE_REFRESH_SESSIONS` | `10` | Signing in on another device revokes the oldest, never the newest |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Window for the per-IP buckets |
| `RATE_LIMIT_MAX_REQUESTS` | `1200` | Per IP, every route |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | `900` | Per IP, the `/api/auth/*` routes. Sized for `npm run smoke`; a real deployment can pick something stricter |
| `OTP_RATE_LIMIT_MAX_REQUESTS` | `300` | Per IP, the two one-time-code routes. Its own bucket because each request can cost an SMS |
| `MESSAGE_RATE_LIMIT_MAX_REQUESTS` | `300` | **Per member**, the group-chat write - spent by `POST /api/groups/:id/messages` *and* the socket's `message:send` from one allowance, so neither transport can be used to buy more. It is the API's only bucket that is not counted per address, and the counters live in the process's memory (see "Group chat" -> Limitations) |
| `MESSAGE_RATE_LIMIT_WINDOW_SECONDS` | `900` | The window that per-member ceiling is measured over - its own value, so the chat bucket can be tuned without touching the per-IP ones |
| `OTP_TRANSPORT` | `log` | `log` writes codes to `backend/.otp-outbox` and reports `delivered: false`; `sms` posts to the provider below. **Production refuses to start with `log`** |
| `OTP_CODE_LENGTH` | `6` | Digits in a generated code |
| `OTP_TTL_MINUTES` | `5` | How long a code stays usable |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong codes per challenge before a new one must be requested |
| `OTP_RESEND_COOLDOWN_SECONDS` | `60` | Minimum gap between two codes for the same number |
| `OTP_MAX_REQUESTS_PER_HOUR` | `5` | Codes one number may request in a rolling hour |
| `OTP_HASH_SECRET` | - | HMAC key for stored code hashes. Required in production; development falls back to `JWT_ACCESS_SECRET` and says so at startup |
| `SMS_PROVIDER_URL` | - | Required when `OTP_TRANSPORT=sms`. Receives `{ to, message, code }` as JSON |
| `SMS_PROVIDER_TOKEN` / `SMS_SENDER` | - | Optional bearer token and sender label for that provider |
| `MAIL_TRANSPORT` | `log` | `log` writes messages to `backend/.mail-outbox`; `smtp` sends them. Only the legacy email endpoints use this now |
| `MAIL_FROM` | `Unihood <no-reply@unihood.local>` | |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASSWORD` | - | Required when `MAIL_TRANSPORT=smtp` |
| `EXPOSE_DEV_TOKENS` | `true` in dev | Returns single-use *email* links in API responses while no provider is configured. Always off in production. There is no equivalent for one-time codes |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated list, or `*`. Only relevant to the web build |
| `ALLOWED_REDIRECT_SCHEMES` | `unihood,exp` | Schemes an email link may redirect back to - the allow-list that stops a crafted link becoming an open redirect |

### Local one-time codes - no SMS provider needed

Local development uses `OTP_TRANSPORT=log` (the default), which needs no account,
no gateway and no paid service: the code is written to a file instead of being
texted, and the API says `delivered: false` rather than pretending otherwise.
`config/env.ts` refuses to start in production with `log`, so a shipped build can
never be configured to "send" codes into a file.

Codes accumulate, newest last, in a git-ignored directory - and the **file is the
only place the code ever appears**: it is never returned in a response, and the
console line names the file rather than repeating the code.

```
backend/.otp-outbox/<timestamp>__<masked number>.txt
```

To read the newest one (run from `backend/`):

```powershell
$file = Get-ChildItem '.otp-outbox' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Select-String -Path $file.FullName -Pattern '^[0-9]{6}$'
```

The whole flow from a shell, for the number `+91 98765 00001`:

```powershell
$body = @{ countryCode = '+91'; nationalNumber = '9876500001' } | ConvertTo-Json
Invoke-RestMethod -Method Post 'http://localhost:4000/api/auth/otp/request' -ContentType 'application/json' -Body $body

$file = Get-ChildItem '.otp-outbox' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$code = (Select-String -Path $file.FullName -Pattern '^[0-9]{6}$').Matches[0].Value

$verify = @{ countryCode = '+91'; nationalNumber = '9876500001'; code = $code } | ConvertTo-Json
Invoke-RestMethod -Method Post 'http://localhost:4000/api/auth/otp/verify' -ContentType 'application/json' -Body $verify
```

The verify response is the usual session payload plus `isNewAccount` and
`onboardingRequired`, which is how the app knows whether to send someone through
onboarding.

### Local email - no provider needed

Local development uses `MAIL_TRANSPORT=log` (the default), which needs no account,
no SMTP server and no paid service, so there is nothing to configure: every
confirmation and password-reset message is written to a file instead of being sent,
and the same single-use link comes back in the API response, so the whole flow
stays testable without a mailbox. The `SMTP_*` values in `backend/.env.example`
exist only for a later deployment and can stay blank.

Messages accumulate, newest last, in a directory next to the server code that is
created on the first message and is git-ignored:

```
backend/.mail-outbox/<timestamp>__<recipient>.txt
```

Each file is plain text holding the link once in the `text/plain` body and again
inside the HTML. To read the newest link (run from `backend/`):

```powershell
$mail = Get-ChildItem '.mail-outbox' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Select-String -Path $mail.FullName -Pattern '/auth/(verify-email|reset-password)\?token=\S+'
```

The same link is in `email.devLink` in the response, which is handier from a script:

```powershell
(Invoke-RestMethod -Method Post 'http://localhost:4000/api/auth/register' `
  -ContentType 'application/json' `
  -Body '{"email":"you@example.com","password":"A-Local-Dev-Password-2026","displayName":"You"}').email.devLink
```

What to do with it:

- **Confirm an address**: open the link. `GET /auth/verify-email?token=...`
  consumes the 24-hour token and redirects into the app
  (`unihood://auth/callback?verified=1` in a standalone build, or
  `exp://192.168.0.5:8081/--/auth/callback?verified=1` in Expo Go).
  `POST /api/auth/verify-email` with `{ "token": "..." }` does the same without a
  browser.
- **Reset a password**: open the link and choose a new password in the app
  (it arrives as `unihood://reset-password?mode=recovery&token=...`), or
  `POST /api/auth/reset-password` with `{ "token": "...", "password": "..." }`. The
  60-minute token is single-use, and a reset revokes every existing session.

Two properties are deliberate: `delivered` stays `false` while the transport is
`log`, so the API never claims an email went out; and `EXPOSE_DEV_TOKENS` - the
switch that puts `devLink` into a response - is forced off when
`NODE_ENV=production`, so a shipped build can never echo a live token. The mobile
UI does not render `email.devLink`, so `.mail-outbox` (or the response, via
`curl`/PowerShell) is the way to a link while developing by hand. `npm run smoke`
writes to the same directory; those files belong to its throwaway `*.invalid`
accounts and can be deleted at any time.

## The API

Base path `/api`; health and email links sit at the root so they work without a
session.

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| GET | `/health` | - | Liveness and version |
| GET | `/health/db` | - | MySQL version, schema, UTC session check (no credentials in the body) |
| POST | `/api/auth/otp/request` | - | Sends a one-time code to a phone number. 202 either way, never contains the code. *The fallback path, for an account with no password* |
| POST | `/api/auth/otp/verify` | - | Checks the code, opens (or creates) the account, returns a session + `isNewAccount` |
| POST | `/api/auth/register` | - | Creates an account from `{ phone, password, displayName }` and signs it in - or, with `{ email, password, displayName }`, the legacy email account that emails a confirmation link |
| POST | `/api/auth/verify-email` | - | *Legacy.* Consumes a confirmation token (single use) |
| POST | `/api/auth/resend-verification` | - | *Legacy.* New confirmation link; 202 either way |
| POST | `/api/auth/login` | - | `{ phone, password }` -> access token, refresh token and member. `{ email, password }` also works, for a legacy account |
| POST | `/api/auth/refresh` | - | Rotates the refresh token; a replayed token revokes every session |
| POST | `/api/auth/logout` | - | Revokes the session behind the refresh token; 204, idempotent |
| POST | `/api/auth/forgot-password` | - | *Legacy.* Emails a reset link (or answers 202 with no link) |
| POST | `/api/auth/reset-password` | - | *Legacy.* Sets a new password and revokes every session |
| GET | `/api/auth/me` | Bearer | The caller, including their own phone number |
| POST | `/api/auth/change-password` | Bearer | Replaces the password: needs the current one, revokes every *other* session and keeps this one |
| DELETE | `/api/account` | Bearer | Closes the caller's account and everything hanging off it. Needs `{ password, confirm: "DELETE" }`; an account with no password is `password_not_set`, and a group it owns that still has other active members is a 409 `ownership_transfer_required` naming them |
| GET | `/api/profile/me` | Bearer | The caller's own profile row |
| PUT | `/api/profile/me` | Bearer | Saves it (validates, replaces interests, marks complete unless `complete: false`) |
| GET | `/api/interests` | Bearer | The curated interest catalogue, grouped by category |
| PUT | `/api/location/me` | Bearer | Stores a rounded fix (needs nearby consent, 10 s throttle) |
| DELETE | `/api/location/me` | Bearer | Forgets the fix; 204 and idempotent |
| GET | `/api/people?mode=nearby\|search&by=name\|skill\|any&q=&interests=&matched=&radius=&limit=&offset=` | Bearer | One page of discovery. `by` decides whether `q` matches a display name, an interest label/slug, or either; `matched=true` keeps only members who share an interest with the caller |
| GET | `/api/people/:id` | Bearer | One member's public profile, or 404 |
| GET | `/api/groups?q=&category=&interest=&matched=&visibility=&limit=&offset=` | Bearer | The group directory (public and private previews); `interest=` filters on the group's own primary interest |
| GET | `/api/groups/nearby?radius=&q=&category=&interest=&matched=&limit=&offset=` | Bearer | Groups within the radius, with an approximate distance - interest matches first, then the closest |
| GET | `/api/groups/mine?limit=&offset=` | Bearer | The groups the caller is an active member of |
| GET | `/api/groups/:id` | Bearer | One group, with the caller's membership and eligibility |
| POST | `/api/groups` | Bearer | Creates the group and the caller's owner membership, in one transaction |
| PATCH | `/api/groups/:id` | Bearer | Owner-only settings (name, description, category, interest, visibility, audience, location) |
| DELETE | `/api/groups/:id` | Bearer | Archives the group (owner-only, 204) |
| POST | `/api/groups/:id/join` | Bearer | Joins a public group, or requests to join a private one |
| POST | `/api/groups/:id/leave` | Bearer | Leaves the group, or withdraws a pending request |
| POST | `/api/groups/:id/join-request/cancel` | Bearer | Withdraws the caller's own pending request |
| GET | `/api/groups/:id/members?limit=&offset=` | Bearer | Active members (members and managers only) |
| GET | `/api/groups/:id/join-requests?limit=&offset=` | Bearer | The pending queue (owner and administrators only) |
| POST | `/api/groups/:id/join-requests/:userId/approve` | Bearer | Approves a request (owner and administrators) |
| POST | `/api/groups/:id/join-requests/:userId/reject` | Bearer | Declines a request (owner and administrators) |
| PATCH | `/api/groups/:id/members/:userId` | Bearer | Promotes/demotes an administrator (owner-only) |
| DELETE | `/api/groups/:id/members/:userId` | Bearer | Removes a member (owner, or an administrator for ordinary members) |
| GET | `/api/groups/:id/messages?limit=&before=` | Bearer | One page of the group's chat, oldest first - active members only |
| POST | `/api/groups/:id/messages` | Bearer | Stores a message (`{ body, clientMessageId? }`), answers 201 with the stored row, then tells the group's room |
| GET | `/auth/verify-email?token=` | - | The browser side of a confirmation link (302 into the app) |
| GET | `/auth/reset-password?token=` | - | The browser side of a reset link (302 into the app) |

Responses are JSON. Failures use one envelope, so the client switches on `code`
and never on prose:

```json
{ "error": { "code": "nearby_disabled", "message": "Nearby discovery is switched off for this account. …", "details": null } }
```

`code` values are the closed list in `backend/src/lib/errors.ts`:
`validation_error`, `invalid_credentials`, `password_not_set`, `email_not_verified`,
`email_taken`,
`invalid_token`, `token_expired`, `unauthorized`, `session_expired`, `forbidden`,
`nearby_disabled`, `location_required`, `audience_not_eligible`, `group_archived`,
`event_full`, `event_ended`, `event_cancelled`,
`not_found`, `profile_not_found`, `rate_limited`, `account_disabled`,
`phone_invalid`, `phone_taken`, `otp_throttled`, `otp_invalid`, `otp_expired`,
`otp_attempts_exceeded`, `internal_error`. A 500 never carries SQL, column names or a
stack - those go to the server log.

## Database

Seventeen tables, created by `backend/migrations/`:

| Table | Holds |
| --- | --- |
| `users` | Account: lower-cased email (unique, nullable since 0008), scrypt password hash (nullable since 0008), the E.164 `phone_e164` (unique) with `phone_verified_at`, display name, `email_verified_at`, `disabled_at`, `last_login_at` |
| `otp_challenges` | One-time codes, one row per request: the phone number, a **keyed** hash of the code, `attempts`/`max_attempts`, `expires_at`, `consumed_at`, `superseded_at`, the requesting IP. Never deleted, which is what makes the hourly cap a real cap |
| `profiles` | The public row: display name, bio, avatar path, area label, `is_discoverable`, `nearby_discovery_enabled`, `profile_completed`, and the optional `group_eligibility_gender` |
| `interests` | The server-owned catalogue (`id`, `name`, `category`, `sort_order`, `is_active`) |
| `profile_interests` | The selected set, replaced wholesale on every profile save |
| `user_locations` | The rounded fix (`latitude`, `longitude` decimals, a `POINT` with SRID 0 and a SPATIAL index, `location_updated_at`) |
| `refresh_sessions` | One row per signed-in device: hashed refresh token, expiry, `revoked_at`, `revoked_reason`, `last_used_at`, user agent, IP |
| `email_verification_tokens` | Hashed single-use confirmation tokens, with the deep link to return to |
| `password_reset_tokens` | Hashed single-use reset tokens |
| `groups` | A group: name, description, category, `interest_id` (nullable, FK to `interests`, since 0010), `visibility`, `audience`, `location_label`, `created_by`, `archived_at` |
| `group_locations` | The group's own geographic anchor (`POINT` with SRID 0, SPATIAL index) - separate from `user_locations`, one row per located group |
| `group_memberships` | One row per group/member pair: `role`, `status`, `joined_at`, `decided_at`, `decided_by` |
| `events` | An event: title, description, category, `start_at`/`end_at`, `location_label`, `created_by`, nullable `group_id`, optional `max_participants`, `status` (`scheduled`/`cancelled`), `cancelled_at` |
| `event_locations` | The event's own geographic anchor (`POINT` with SRID 0, SPATIAL index) - one row per located event, separate from `user_locations` and `group_locations` |
| `event_rsvps` | One row per event/member pair forever: `status` (`going`/`not_going`/`cancelled`, the third state added by 0011), `rsvped_at`, `cancelled_at`, with `UNIQUE (event_id, user_id)` |
| `group_messages` | The chat (0011): `group_id`, `sender_id`, `body` (1-1000, stated as a `CHECK`), nullable `client_message_id` (the idempotency key), `created_at`; the foreign keys cascade from `groups` and `users`, so an orphan message is impossible |
| `schema_migrations` | Which migration ran, when, and the SHA-256 of the file that ran |

Nothing cascades into a mystery: every child table has
`FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`, so deleting an
account removes its profile, interests, location, sessions, tokens and group
memberships. `groups.created_by` cascades the same way, taking a group the member
created with it, and `group_memberships` cascades from `groups` as well - so a
deleted account can never leave a membership pointing at nothing.

### Migrations

`npm run db:migrate` applies pending files in filename order (`NNNN_name.sql`),
each inside a transaction, under a MySQL advisory lock (`GET_LOCK`) so two
deployments cannot race. Every applied file is recorded with its **checksum**:
`npm run db:status` reports `edited` if a file changed after it was applied, which
is why a fix to an applied migration is a *new* migration rather than an edit -
`0005_account_disable.sql` exists for exactly that reason.

```bash
npm run db:status   # applied / pending / edited, file by file
npm run db:check    # connectivity, server version, schema, UTC session, count
```

`0006_groups.sql` is the Phase 3 migration, `0007_events.sql` is the Phase 4 one
(events, their geographic anchors and RSVPs), Phase 5 adds two:
`0008_phone_otp.sql` (nullable `email`/`password_hash`, `phone_e164`,
`phone_verified_at`, and the `otp_challenges` table) and
`0009_interests_catalogue.sql` (the `category` column and the curated ~150-interest
seed), Phase 6 adds `0010_group_interest.sql` (the nullable `groups.interest_id`),
and Phase 7 adds `0011_group_chat_and_rsvp_responses.sql` (`group_messages`, and the
third `event_rsvps.status` value `not_going`), and the MVP polish pass adds
`0012_location_persistence.sql`, which drops the `user_locations_freshness_idx`
index left behind by the removed 24-hour rule - a saved area is persistent now, so
nothing orders or filters by `location_updated_at` and the index had no reader
left. 0011 is the one migration that
*changes* an existing `CHECK` without rewriting a row: every `going` and `cancelled`
row keeps exactly the meaning it had, so there is nothing to reverse. 0006 also
records two facts about this
server that a future schema change has to respect, both measured rather than
assumed:

- **`GROUPS` is a reserved word** in MySQL 8 (window-function frame clauses), so the
  table is written `` `groups` `` with backticks in the migration and in every query
  in `groupService.ts`. The name is the product's own vocabulary; the quoting is the
  price.
- **A `STORED` generated column makes InnoDB refuse every foreign key on that
  table** with `ER_CANNOT_ADD_FOREIGN`, even when the foreign keys are on ordinary
  columns. The single-owner constraint in `group_memberships` is therefore a
  `VIRTUAL` generated column (`owner_key`) with a `UNIQUE` index: the index
  materialises it, the guarantee holds, and the foreign keys still work.

## Groups

Groups are served by the API. `groups`, `group_locations` and `group_memberships`
are MySQL tables, and `src/services/groupService.ts` is the only code that knows
their shape. Nothing about a group - who is in it, who may join it, where it is -
lives on the device, so a group and its memberships survive an app restart, a device
change and an API restart.

### Schema

| Table | Columns worth knowing |
| --- | --- |
| `groups` | `name` (3-60), `description` (1-280), `category`, `visibility` (`public`/`private`), `audience` (`everyone`/`men_only`/`women_only`), `location_label` (0-80), `created_by`, `archived_at` |
| `group_locations` | `group_id` (primary key), `latitude`/`longitude` `DECIMAL(8,4)`, `location POINT NOT NULL SRID 0` with a SPATIAL index |
| `group_memberships` | `role` (`owner`/`admin`/`member`), `status` (`pending`/`active`/`rejected`/`left`/`removed`), `joined_at`, `decided_at`, `decided_by`, and a `UNIQUE (group_id, user_id)` key |
| `profiles` | `group_eligibility_gender` (`man`/`woman`/`another`/`prefer_not_to_say`, or NULL) |

Three constraints carry rules that would otherwise only exist in code:

- `UNIQUE (group_id, user_id)` makes a duplicate membership structurally impossible;
- `UNIQUE (owner_key)` makes "exactly one active owner per group" a database
  guarantee, because `owner_key` is the group id for the owner row and NULL for
  every other row (a UNIQUE index permits any number of NULLs);
- `CHECK (status <> 'active' OR joined_at IS NOT NULL)` means an active membership
  always records when it became active.

### Creating a group

| Field | Required | Notes |
| --- | --- | --- |
| Name | yes | 3-60 characters |
| Short description | yes | 1-280 characters, shown on the card and as the page standfirst |
| Category | yes | one of `sports`, `coding`, `study`, `social`, `music`, `arts`, `gaming`, `travel`, `general` |
| Visibility | yes | `public` or `private`; defaults to public |
| Audience | yes | `everyone`, `men_only` or `women_only`; defaults to everyone |
| Location label | no | up to 80 characters, human-readable ("Riverside Park, north gate") |
| Geographic anchor | no | taken from one tap on "Use my current location" |

The creator becomes the owner, and the group row and the owner membership row are
written in a single transaction - a group with no owner cannot exist, even if the
request is interrupted. The category list is owned by the server
(`backend/src/domain/groups.ts`), validated by zod at the edge and constrained again
by a `CHECK` on the column.

### The geographic anchor

A group's location is its own record, and it is deliberately **not** derived from
anything already stored about its creator:

- it is written only when the member taps "Use my current location" in the form;
  one coarse reading is taken (`Accuracy.Low`), it is rounded to 4 decimal places
  (~11 m) and it goes straight into `group_locations`;
- the member's own `user_locations` row is never read, copied or exposed - the smoke
  test asserts that creating a group writes no location row unless one was sent;
- latitude and longitude must arrive as a pair, be in range, and not both be exactly
  0, which is what a handset reports when it has no fix at all. (Unlike
  `user_locations`, 0 is allowed on one axis, because 0° is a real longitude and a
  real latitude for a *place*);
- the anchor can be replaced (tap again) or removed ("Remove"), which puts the group
  back to having no location;
- the API never returns a coordinate. A group response carries `hasLocation` and, in
  a nearby search, `distanceMeters` rounded to 50 m - nothing else.

**Nearby discovery** asks the database rather than the device: the radius is
validated and clamped to the shared 1-10 km window (default 5 km), the candidate rows
are narrowed by a bounding box that uses the SPATIAL index (`MBRContains` over
`ST_MakeEnvelope`), and the exact `ST_Distance_Sphere` test runs afterwards with
**longitude first**, matching what migration 0003 measured. The origin is the
caller's own stored fix, never a request field, so "which groups are near this
address?" is not a question the API can answer. Requires a stored area - however
long ago it was saved - otherwise the answer is `location_required` and the app
explains that nearby needs a location, keeps the other two listings working, and
offers "Browse all groups".

Consequences worth stating plainly:

- an **archived** group never appears in nearby results;
- a group with **no anchor** never appears in nearby results and never reports a
  distance, so the app never implies a group is within 5 km when that cannot be
  determined;
- an ineligible audience is filtered out at the database, so a restricted group is
  invisible to members who cannot join it.

### Visibility

| | Public | Private |
| --- | --- | --- |
| Appears in discovery | yes | yes, as a preview |
| Join | immediately, with no approval | creates a pending request |
| Member list | members and managers only | members and managers only |
| Organiser name | shown | shown only to members |
| Description | shown | shown (it is the preview) |

`memberCount` is public for both, because a count says nothing about *who*. The
member list and the request queue are separate endpoints that re-check the caller's
role on every call.

### Audience and eligibility

`audience` restricts who may **discover and join** a group:

| Audience | Who qualifies |
| --- | --- |
| `everyone` | any eligible member, whatever their own setting |
| `men_only` | members whose `group_eligibility_gender` is `man` |
| `women_only` | members whose `group_eligibility_gender` is `woman` |

The eligibility value is optional, self-declared and never required: registration
never asks for it, onboarding offers it as an optional chip row, it is off by
default, and it appears in the profile **editor** as "Gender (optional)" (with a
chip row that can clear it again).
`another` and `prefer_not_to_say` are stored as answers, but neither qualifies a
member for a restricted audience - only `man` and `woman` do, and an unset value
fails both. Someone whose setting does not match can still open a restricted group's
page; the API answers `viewerEligible: false` and the screen explains why instead of
showing a button that cannot work.

Privacy rules, all enforced server-side and asserted by the smoke test:

- the value is never returned in a public projection (`/api/people`, `/api/people/:id`);
- it is never part of a group member list, so an owner or administrator cannot inspect
  another member's setting;
- only the member can change their own value (there is no endpoint that accepts a
  target user id);
- a client-supplied `audience` or gender value is never trusted: the rule reads the
  caller's own row inside the same transaction as the write;
- a creator of a restricted group must satisfy that group's audience themselves.

### Membership, roles and what each role may do

| Status | Meaning | Can they get back in? |
| --- | --- | --- |
| `pending` | a request awaiting approval (private groups) | the request can be withdrawn and re-sent |
| `active` | a member | - |
| `rejected` | an administrator declined the request | no; an administrator would have to change the decision |
| `left` | left voluntarily, or withdrew a request | yes - join/request works again |
| `removed` | removed by an owner or administrator | no; an administrator would have to change the decision |

A membership row is never deleted: a status change is an `UPDATE`, which is why a
declined request, a voluntary exit and a removal are all still visible to the people
running the group. `decided_at` and `decided_by` record who made a decision.

| Role | May |
| --- | --- |
| **Owner** (exactly one per group) | edit every setting, archive the group, approve/decline requests, promote and demote administrators, remove any member, read the member list |
| **Administrator** | approve/decline requests, read the member list, remove ordinary members - but not edit the group, not archive it, not change anyone's role, not remove another administrator or the owner |
| **Member** | see member-only information and the member list, leave the group |
| **Non-member** | see a public group (or a private group's preview), and join or request to join |

The rules that are easy to get wrong, and where they are enforced:

- **A request never activates itself.** `POST /join` decides from the *stored*
  visibility, so no payload can make a private group's request active.
- **Approval re-checks eligibility**, because a member's own setting can change
  between the request and the decision.
- **An owner cannot leave.** A group with no owner would be unmanageable, and there
  is no ownership transfer in this phase, so the owner's way out is to archive.
- **Administrators cannot escalate.** `owner` is not an accepted value for a role
  change, and only the owner may call it - so nobody can promote themselves, a peer,
  or anyone else to owner.
- **Nobody removes themselves** with the removal endpoint; "leave group" is that
  action, and it is deliberate.
- **Removal and rejection are terminal.** Repeating `POST /join` afterwards answers
  `403 forbidden` and explains why, which is the documented re-entry rule; there is
  no re-invite endpoint yet (see the limitations below).
- **Archiving revokes ordinary access** without deleting anything: the group
  disappears from every listing, and every mutation is refused with
  `group_archived` (409).

### Using it locally

```bash
cd backend
npm run db:migrate     # applies every pending file (0006 among them)
npm run db:status      # expect: applied 12, pending 0, edited 0
npm run dev            # terminal 1
npm run smoke          # terminal 2: 772 end-to-end checks, including every group rule
```

In the app (Expo Go or a dev build, with the API reachable):

1. **Groups → All groups** lists what exists; **Nearby** needs a location, which you
   store once from Profile → "Your location" (or the group form's own button).
2. Tap **+** to create a group. Give it a name and short description, pick a
   category, choose public or private, then tap **Use my current location** if you
   want it to appear in nearby search.
3. On the new group's page you are the **owner**: "Manage group" opens the request
   queue and member list, and "Edit group settings" is where archiving lives.
4. To see the other side, sign in as a second account (or invite one), find the
   group, and join or request. A private group's request shows as **Request
   pending** on the card and page, and appears in the owner's queue.
5. To exercise **audience rules**, set "Gender" in Profile → Edit
   profile, then create a men-only or women-only group (or try to join one you do
   not qualify for - the page will say so).

### Limitations, and what is deliberately not here yet

- **No ownership transfer.** The owner cannot hand a group on, so their only exit is
  archiving. The schema enforces one owner, and the service has the demote-then-
  promote ordering ready for a transfer endpoint.
- **No re-invite after removal or rejection.** Both are terminal states with no
  endpoint that re-opens them.
- **Group events are live now.** A group's page lists that group's real upcoming
  events from the API, and an active member can host one straight from it - see the
  Events section below.
- **No group chat, posts, feed or payments** - deliberately out of scope for this
  phase.
- **Audience eligibility is self-declared**, not verified. No identity documents are
  collected, and `another` / `prefer_not_to_say` are answers that simply do not match
  a restricted audience.

## Events

Events are rows in MySQL (`backend/migrations/0007_events.sql`), served by
`backend/src/services/eventService.ts` and consumed through
`src/features/events/eventRepo.ts`. The Phase 1 mock catalogue was deleted with the
screens that read it: nothing in the app invents an event, an attendee count or a
distance any more.

### The model

| Field | Notes |
| --- | --- |
| `title`, `description` | 3-80 and 1-600 characters, enforced by a `CHECK` *and* with a member-facing message |
| `category` | one of `sports`, `coding`, `study`, `social`, `music`, `arts`, `gaming`, `travel`, `general` - the same vocabulary groups use |
| `start_at`, `end_at` | UTC instants (`DATETIME(3)`, session pinned to `+00:00`); an event must end after it starts and may not run longer than 30 days |
| `location_label` | the human-readable venue ("Riverside Park, north gate"), up to 120 characters |
| `event_locations` | the optional geographic point, written only from an explicit tap in the form - never from the organiser's saved location |
| `created_by` | the organiser: always the caller, never a client-supplied id |
| `group_id` | `NULL` for a standalone event; otherwise a real group |
| `max_participants` | `NULL` means "no limit" |
| `status`, `cancelled_at` | `scheduled` or `cancelled`, kept in step by a `CHECK` so a half-cancelled row cannot exist |

Timestamps travel as ISO 8601 UTC (`2026-10-10T18:00:00.000Z`) and every screen
renders them in the device's own timezone (`src/lib/date.ts`), so an 11 pm event in
Delhi belongs to the day the member actually turns up on.

### Standalone events, and group events

- A **standalone** event (`group_id IS NULL`) is discoverable by any authenticated
  member, and anyone eligible can RSVP to it.
- A **group** event has no visibility setting of its own - it inherits the group's:
  - a **public group's** event is discoverable and RSVP-able by everyone the group's
    `audience` accepts, member or not;
  - a **private group's** event is visible only to active members (and to its owner or
    administrators). A pending, rejected, left or removed membership grants nothing.
- One database predicate decides every read, and it is part of the `WHERE` clause - so
  a guessed private event id is a **404**, indistinguishable from an id that never
  existed. It leaks through no listing, no group filter, no guest list and no Going
  list either.
- Attaching an event to a group is a membership decision: the caller must be an
  **active member** of it, and its audience must accept them. An edit cannot move an
  event between groups at all (`groupId` is not patchable).

### Nearby discovery

Default radius **5 km**, clamped to the shared 1-10 km window, exactly as nearby
people and nearby groups are. The candidate rows are narrowed by a bounding box that
uses the SPATIAL index on `event_locations.location` (`MBRContains` over
`ST_MakeEnvelope`), and the exact `ST_Distance_Sphere` test runs afterwards with
**longitude first**. The origin is the caller's own stored fix - never a request
field - and a saved area does not expire: it stays in force until its owner
replaces it, switches nearby discovery off (which deletes it in the same profile
write) or closes the account. Without one the answer is
`location_required` (409), and the app explains that while keeping My groups and Going
working, because those need no coordinates at all.

Consequences worth stating plainly:

- a cancelled or already-finished event is never a nearby result;
- an event with **no anchor** is never presented as confirmed nearby. It is still
  listed without a distance - on its group's page, in My groups and in the directory -
  which is the honest answer to "is this within 5 km?";
- a private group's event is filtered out before any event data is returned;
- the distance is rounded to 50 m and no coordinate is ever returned.

### RSVPs, capacity and the lifecycle

| Operation | Endpoint | Notes |
| --- | --- | --- |
| Going | `POST /api/events/:id/rsvp` | idempotent "yes"; refuses a cancelled, ended, full or unauthorised event |
| Answer | `PUT /api/events/:id/rsvp` | `{ "status": "going" \| "not_going" }` - the explicit answer (Phase 7). Anything else, `cancelled` included, is a `validation_error`: withdrawing is a different request |
| Withdraw | `DELETE /api/events/:id/rsvp` | "I have no answer". The row stays, marked `cancelled`, and the event returns to Needs response - a safe no-op when there is nothing to withdraw |
| Guest list | `GET /api/events/:id/attendees` | display names only, behind the event's own visibility rule |

- **One row per (event, member) forever.** The unique key makes a duplicate RSVP
  structurally impossible and a state change is an `UPDATE` - never a second row,
  never a `DELETE`.
- **Three states, and two of them are answers.** `going` ("I am coming"),
  `not_going` ("I saw it and I am not coming") and `cancelled` ("I have no answer").
  Only `going` counts towards capacity and only `going` is in the guest list.
  `not_going` is stored with `cancelled_at IS NULL` *because* it is not a
  cancellation, and a `CHECK` keeps the row honest - so declining and withdrawing can
  never be confused for each other, at rest or on the wire.
- **The Events feed reads exactly those states.** `needs_response` is the rows with no
  answer *or* a withdrawn one (`cancelled`), and `not_going` is deliberately not part
  of it, because declining is an answer. A declined event stays in All upcoming: it
  did not disappear, the member just said no to it.
- **Capacity is decided under a lock.** Every RSVP takes a `FOR UPDATE` lock on the
  event row first and counts the going rows under the same lock, so three simultaneous
  requests for two places accept exactly two and the third gets `event_full` (409).
  There is no waiting list. Only `going` consumes a place, so answering Not going to a
  full event always works - and switching from Not going to Going on a full event gets
  `event_full` and leaves the previous answer in place.
- **Withdrawing an RSVP keeps the history.** The row stays, marked `cancelled`, so it
  stops counting immediately (the count is `status = 'going'`), leaves Going and Not
  going, and returns the event to Needs response. The row remains readable to whoever
  may read the event.
- **Cancelling an event** writes `status = 'cancelled'` and `cancelled_at`. Nothing is
  deleted: the RSVP rows survive, the event leaves every listing, new RSVPs are refused
  with `event_cancelled` (409), and the page still says what happened. There is no way
  to reopen one.
- **An archived group's events** are closed too: out of every listing, no new RSVPs
  (`group_archived`, 409), and still readable by the group's active members so its
  history is not lost.
- Cancelling an RSVP to a finished or cancelled event is deliberately still allowed:
  withdrawing is always safe, and refusing it would leave someone counted as going to
  something that no longer exists.

### Who may edit or cancel what

- the **creator** of a standalone event;
- the **creator of a group event, while they are still an active member** of that
  group - leaving, or being removed, hands the event to the group, and usually takes
  away their ability to read it at the same time;
- the group's **owner or an administrator**, always - which is the recovery path if the
  creator disappears.

`viewerCanManage` is the server's own answer to that question, and it is re-derived on
every write: hiding a button is a convenience, never the rule.

### The event API

```
GET    /api/events/nearby?q=&category=&radius=&limit=&offset=
GET    /api/events/feed?q=&category=&groupId=&response=&limit=&offset=
                       # response = upcoming | needs_response | going | not_going
                       # (the Events tab: the caller's groups' calendar, one list)
GET    /api/events/mine?limit=&offset=          # groups the caller is active in
GET    /api/events/going?limit=&offset=         # the caller's own RSVPs
GET    /api/events?q=&category=&groupId=&limit=&offset=
GET    /api/events/:id
POST   /api/events                 -> 201 { event }
PATCH  /api/events/:id             -> { event }
DELETE /api/events/:id             -> { event } (cancel)
POST   /api/events/:id/rsvp        -> { event } (Going, idempotent)
PUT    /api/events/:id/rsvp        -> { event } ({ status: going | not_going })
DELETE /api/events/:id/rsvp        -> { event } (withdraw the answer)
GET    /api/events/:id/attendees?limit=&offset=
```

Every event row carries `viewerRsvpStatus` - `going`, `not_going`, `cancelled` or
`null` when the member has never answered - so the feed, the card and the detail page
all describe the same fact, and the client never has to infer an answer. Every listing
is bounded (20 by default, 50 maximum), deterministic (`start_at` then `id`, distance
first for nearby) and answers
`{ page: { events, offset, hasMore, nextOffset } }`. A mutation answers with the
refreshed event, so the client never invents a post-action state.

### Using it locally

```bash
cd backend
npm run db:migrate     # applies 0007, 0011 and 0012 if they have not run yet
npm run db:status      # expect: applied 12, pending 0, edited 0
npm run dev            # terminal 1
npm run smoke          # terminal 2: 772 end-to-end checks, including every event rule
```

In the app (with the API reachable):

1. **Events** opens on *All upcoming*: the scheduled, not-yet-ended events of the
   groups you are an active member of, soonest first. **Needs response**, **Going** and
   **Not going** are that same list read through your own answer, which is what makes
   it impossible for the four slices to disagree about an event.
2. Tap **+** to post an event. The form asks for **Hosted by** and requires it - every
   event created from the app belongs to one of your groups, which is what the feed can
   answer for. (A standalone event is still accepted by `POST /api/events` and still
   readable by id; it is simply not part of "what my groups have on".) Give it a title,
   a description, a category and a local date and time, a venue label, and a map
   position if you want it discoverable nearby; leave the participant limit blank for
   no cap.
3. **Nearby discovery is no longer a segment on this tab.** The API still answers
   `GET /api/events/nearby` for a caller with a stored fix, and the map position on an
   event is what that listing is built from, but the tab's own question is now "what do
   my groups have on".
4. Open an event and answer **Going** or **Not going**. The count, the "Full" state and
   the guest list all come from the server; change your answer, decline, or withdraw it
   as often as you like - it is one row either way.
5. As the organiser, **Edit event** and **Cancel event** live on the event page and in
   the editor. A private group's event is invisible to anyone outside that group, even
   with the link.

### Limitations, and what is deliberately not here yet

- **No waitlist.** A full event refuses new RSVPs with `event_full` and says so. Not
  going is always accepted, and only Going takes a place.
- **No recurring events.** One row is one occurrence.
- **No event chat, comments, likes, tickets or payments** - out of scope for this
  phase. The chat in Phase 7 belongs to a *group*, not to an event.
- **No ownership transfer.** An event has one creator; a group event's owner or
  administrators can manage it, but nobody can hand it on.
- **Times are typed, not picked.** There is no date-picker dependency, so the form
  takes `YYYY-MM-DD` and 24-hour `HH:mm` in the device's timezone, and one event runs
  inside a single local day (the end time must be after the start time).
- **Going is upcoming only.** A finished or cancelled event drops out of Going, though
  its page and its attendance history stay readable.

## Group chat

Chat is a group's own history, not a private conversation: anyone who may read the
group may read it, and nobody who has left can. One table is involved
(`group_messages`), one service knows its shape (`backend/src/services/chatService.ts`)
and one feature folder is the mobile side (`src/features/chat/`).

### Two transports, one code path

| | History | Sending |
| --- | --- | --- |
| HTTP | `GET /api/groups/:id/messages` - always, socket or not | `POST /api/groups/:id/messages` |
| Socket.IO | - | the `message:send` event |
| Delivery | - | `message:created`, broadcast to the group's room |

- **The socket lives on the API's own server and port** (`/realtime`,
  `backend/src/realtime/socket.ts`), so there is no second process, no second port, no
  second certificate and no second CORS story. `GET /health` reports
  `realtime: true` while this process is carrying it, and `false` is not an error: the
  channel is an optimisation and every HTTP route works without it.
- **The handshake carries the access token.** The same `resolveTokenCaller` an HTTP
  request goes through verifies it, and a refused handshake answers `unauthorized` or
  `session_expired` instead of opening a connection. A user id sent by the client is
  never read, on the handshake or on any event.
- **Joining a room is an authorization decision.** `group:join` looks the group up and
  checks membership through the chat service *before* the socket joins `group:<id>`; an
  archived group answers `group_archived` - the room closes, the history stays.
- **Every send is authorized again.** `message:send` calls the same `sendGroupMessage`
  the HTTP endpoint calls, so being in a room short-cuts nothing: a socket that was
  somehow left in a room still cannot write to it, and a message that arrived over a
  WebSocket is validated, authorized and stored by the same code as one that arrived
  over HTTP.
- **Every client event is acknowledged with a real answer** - the committed message, or
  the refusal carrying the API's own error code - so a client awaits a result instead of
  watching for a broadcast and hoping.
- **Eviction is server-driven.** Leaving, being removed, and archiving the group pull
  the member's sockets out of the room (`backend/src/realtime/hub.ts`), and a periodic
  sweep (`REALTIME_SESSION_SWEEP_MS`, one minute) disconnects any socket whose session
  has been revoked or has expired - the real-time half of "sign out on every device".
- **The screen never hides a failure.** It shows `connecting`, `live`, `offline` or
  `blocked`, and `blocked` - the session is gone, or this member may not read this room
  - is a statement rather than a retry button. When the socket is down, sending falls
  back to the HTTP write and the message still lands.

### The rules the chat keeps

- **Identity comes from the session**, never from the payload. A `senderId` in a
  request body is ignored, over both transports.
- **An active membership is required for every read and every write.** Pending,
  rejected, left and removed memberships read nothing and post nothing; a guessed group
  id is a 404, indistinguishable from an id that never existed.
- **Nothing is deleted.** A removed member's messages stay in the history, and an
  archived group keeps its messages readable while refusing new ones with
  `group_archived` (409).
- **A duplicate send is the same send.** `clientMessageId` (a fresh UUID per intended
  message, minted by `newClientMessageId`) plus `UNIQUE (group_id, sender_id,
  client_message_id)` turns a double tap or a retry after a dropped connection into the
  row that already exists rather than a second copy.
- **Paging is a cursor, not an offset.** `before=` is the id of the oldest message the
  client already holds, because messages arrive while a member scrolls and an offset
  would re-serve rows. The page is 30 by default and 100 at most, ordered oldest first,
  and answers `{ page: { messages, hasMore, nextCursor } }`.
- **Writes spend one budget, per member, whichever transport carries them.** Every
  attempt to post - `POST /api/groups/:id/messages` and the socket's `message:send`
  alike - draws on the same `MESSAGE_RATE_LIMIT_MAX_REQUESTS` allowance (300 writes per
  15 minutes by default, measured over `MESSAGE_RATE_LIMIT_WINDOW_SECONDS`), keyed by
  the authenticated member rather than by an address or a connection. Switching
  transport, or opening a second device, buys nothing, and a chatty chat budget cannot
  spend the general API one. The unit is taken after the session is checked and before
  the body is read, so an attempt costs the same whether or not it would have been
  stored; parallelism cannot slip past it, because the counter is incremented with no
  `await` in between; and the refusal is the API's own `rate_limited` - `429` with
  `Retry-After` and `retryAfterSeconds` over HTTP, and the same code, wait and sentence
  in the socket's acknowledgement, without the connection being dropped.

### Using it locally

```bash
cd backend
npm run db:migrate     # applies 0011 and 0012 if they have not run yet
npm run db:status      # expect: applied 12, pending 0, edited 0
npm run dev            # terminal 1 - the startup log confirms the realtime endpoint
npm run smoke          # terminal 2: 772 end-to-end checks, including the chat checks
```

1. Open a group you are an **active member** of and tap **Open group chat**.
2. Send a message. It is stored first and broadcast second, so it is in the history
   whether or not anyone else was connected at the time.
3. Open the same group as a second member and the message arrives with no refresh; the
   header says whether the channel is live.
4. A non-member who reaches `/group/chat/<id>` by hand is told chat is for members, and
   the API agrees: the history request is a `forbidden` (and a 404 when the id does not
   exist at all), which the screen draws as the same members-only state.

### Limitations, and what is deliberately not here yet

- **No editing or deleting a message.** The rows are the record; an edit history and a
  redaction story are their own design.
- **No typing indicators, read receipts, reactions, attachments or direct messages.**
  This is a group's chat, not a messenger.
- **No push notifications.** A member sees a message when the screen is open - the
  socket is a live channel, not a wake-up service.
- **No moderation tools.** Membership is the only lever, and it is immediate: removing
  a member from the group ends their access to the room, and archiving the group closes
  it for everyone.


## Phone and password

The user-facing credential is a **phone number and a password**. One screen carries
both halves of the flow: **Sign in** (number + password) and **Create an account**
(name + number + password).

1. The member picks a dialling code (or types one) and their number. The API
   normalises the pair to **E.164** and rejects anything that is not a real
   international number, with a sentence naming the mistake ("Leave out the
   leading 0…"). The same normalisation and the same sentences are used by every
   phone route, including the code path below.
2. `POST /api/auth/register` with `{ phone, password, displayName }` creates the
   account: the number is stored as the unique identifier, the password as a scrypt
   hash, and the profile row next to it in the same transaction. It answers **201
   with a session** plus `onboardingRequired`, because the password has just been
   checked and asking for it again would be theatre.
3. `POST /api/auth/login` with `{ phone, password }` verifies the password and
   opens the ordinary session. A wrong password and a number that has no account
   answer **identically** (`invalid_credentials`, and one scrypt comparison either
   way), so the endpoint cannot be used to find out which numbers are registered.
4. The number is **claimed once**. Registering a number that any account already
   has - including an account created by a code - is refused with `phone_taken`,
   because nothing on this path proves the caller holds the number and letting them
   set a password on somebody else's account would be a takeover.
5. **Registering does not mark the number verified.** `phone_verified_at` stays
   NULL: no code was checked, and the column keeps meaning "proved by a code".
   Signing in is not gated on it either, or every account this flow creates would be
   locked out of itself.

What the password rules are, and where they live:

- **scrypt from Node's `crypto`** - `backend/src/lib/password.ts`, the same
  function the reset endpoint uses. Stored self-describing as
  `scrypt$N$r$p$<salt>$<hash>`, verified with `timingSafeEqual`, and upgraded in
  place on the next successful sign-in when the cost parameters have been raised.
- **A minimum length of 8** (`MIN_PASSWORD_LENGTH`), mirrored by the form, plus a
  short rejection list for the handful of passwords that appear in every
  credential-stuffing list, for a password of digits only, and for one built out of
  the member's own **name** or **number**.
- **No plaintext anywhere.** The API never echoes a password back, never logs one,
  and the mobile app does not keep one on the device.

### The code path, and why it is still there

An account created by a one-time code in an earlier version has **no password
hash** (`users.password_hash` is nullable since migration 0008, and nothing
invented one for it). `POST /api/auth/login` cannot sign such an account in, so it
answers `password_not_set` - after running the same dummy scrypt comparison, so the
timing still says nothing - and the app shows that sentence as it is: with no code
form left to switch to, the only fix is for whoever runs Unihood to set a password
on the account.

Nothing in the app creates an account through a code any more, and no password is
ever assigned automatically. The whole code surface below is unchanged for the
accounts that need it:

1. `POST /api/auth/otp/request` answers **202 either way** - it never says whether
   the number has an account - and returns a *masked* number, the transport, and
   the resend cooldown.
2. The member types the code; `POST /api/auth/otp/verify` checks it, consumes it
   and returns the ordinary session payload plus `isNewAccount` and
   `onboardingRequired`.
4. A new account gets `<id>` in `users` with `phone_e164`/`phone_verified_at` set,
   a `profiles` row (placeholder name, `profile_completed = 0`), and a session - so
   the same root guard that sends an unfinished profile to onboarding takes them
   there. `PUT /api/profile/me` finishes it.

What the codes are protected by:

- **Cryptographically random** (`crypto.randomInt`, rejection-sampled - no modulo
  bias), six digits by default.
- **Only a keyed hash is stored**: `HMAC-SHA256(OTP_HASH_SECRET, challengeId + ':' + code)`.
  A six-digit code has ~20 bits of entropy, so a plain SHA-256 of it would be
  exhaustive-searchable by anyone who read the table; a keyed digest is not.
  Comparison is `timingSafeEqual`.
- **Five minutes**, single use, and **only the newest code works** - requesting
  again marks earlier unconsumed challenges `superseded_at`, in the same
  transaction as the insert.
- **Attempts are capped** (5 by default) per challenge, and a spent challenge
  demands a new code rather than allowing more guesses.
- **Per-number limits**: a 60-second resend cooldown and 5 codes per rolling hour.
  Superseded rows are kept precisely so asking again cannot clear the count, and a
  refusal carries `retryAfterSeconds` so the screen can count down instead of
  guessing.
- **Per-IP limits**: `otpLimiter` (`OTP_RATE_LIMIT_MAX_REQUESTS`, 30/15 min by
  default) sits under the general auth bucket, so one address cannot walk a list
  of numbers.
- **No enumeration**: an unknown number, a spent code and a replaced code all
  answer `otp_invalid` with wording that describes the *code*, never the account.
  A disabled account is only named after the code has matched - the device holding
  the number is told, and nobody else can learn it.
- **The code is never in a response.** With `OTP_TRANSPORT=log` it is written to
  `backend/.otp-outbox/` (see
  [Local one-time codes](#local-one-time-codes---no-sms-provider-needed)); the
  console line names the file rather than printing the code.

One piece of housekeeping worth knowing about: `otp_challenges` rows are never
*updated* away, because that is what makes the rolling-hour cap honest, so the
table would grow by one row per request. `requestOtp` therefore prunes rows older
than a day for the number being used. A deployment with real traffic should also
sweep the whole table on a schedule (nothing depends on those rows after an hour).

### Legacy email accounts

Migration 0008 makes `users.email` and `users.password_hash` nullable and adds
`phone_e164` **without touching a single existing row**. An account created before
this phase keeps its id, email, password hash, profile, interests, groups and
events, and gets no phone number - nothing invents one or claims one on its
behalf.

Those accounts keep working through the email endpoints, which stay mounted for
exactly this reason (`/api/auth/register`, `/login`, `/verify-email`,
`/forgot-password`, `/reset-password` and the two `/auth/*` browser pages). The
app no longer has screens for them, so the honest bridge is one deliberate step:

```powershell
# From backend/ - attach a number you control to an existing account.
$env:PHONE_LINK_EMAIL = 'you@example.com'
$env:PHONE_LINK_PHONE = '+919876543210'
npm run phone:link
```

The tool validates and normalises the number, refuses one that another account
already has, refuses an unknown email, and changes **only**
`phone_e164`/`phone_verified_at`. The account's owner can then use the phone
screen like anyone else. The smoke test performs the same operation and asserts
that the account keeps its id, email and finished profile.

A **phone-only** account - one created by a code in Phase 5 - is the other legacy
case, and it needs no migration at all: it keeps its number, its profile, its
interests, its groups, its events and its messages, it still has no password hash,
and it signs in through the code path. Registering its number with a password is
refused with `phone_taken`, so the account cannot be claimed by whoever types that
number next, and nothing ever assigns it a password.

## How authentication works

- **A session is a session.** A correct password produces exactly what a verified
  code does: a short-lived access token and a rotating refresh session. Nothing in
  the session machinery knows which of the three credentials was presented.
- **Access tokens**: JWTs (HS256), 15 minutes, carrying `userId` and `sessionId`.
  Nothing else - a JWT is signed, not encrypted.
- **Refresh tokens**: 256 bits of `crypto.randomBytes` in base64url, stored only
  as a SHA-256 hash, valid 30 days, one per device, capped per account (the oldest
  is revoked rather than refusing a new sign-in).
- **Rotation**: every refresh retires the token it was given and issues a new
  pair. Presenting an already-rotated token is treated as theft and revokes every
  session on the account.
- **Revocation is immediate**: `requireAuth` looks the `sessionId` up in
  `refresh_sessions` on every request, so a sign-out, an email password reset or
  a disabled account invalidates access tokens that have not yet expired.
- **The code is the only credential that is short-lived by design.** Everything
  else about the session is unchanged from Phase 4, and the smoke test's session
  section runs against a phone-and-password session and a code-based one.
- **Passwords**: scrypt from Node's `crypto` (N=16384, r=8, p=1, 16-byte salt,
  64-byte key), stored self-describing as `scrypt$N$r$p$<salt>$<hash>`, compared
  with `timingSafeEqual`, and raised to the current cost on the next correct
  sign-in when the stored parameters are older. `/api/auth/login` refuses an
  unknown phone number with the same `invalid_credentials` a wrong password gets -
  and so does the legacy branch, for an unknown email address - running one scrypt
  comparison against a fixed dummy hash either way so the timing says nothing. The
  single case that answers differently is a number whose account has **no password
  at all**: `password_not_set`, which is exactly what the code path is still for.

## Privacy and the location model

- **A coordinate is never returned to anyone.** There is no read endpoint at all;
  `PUT /api/location/me` answers only with the timestamp, and the public profile
  projection has no coordinate fields. The smoke test asserts this.
- **Consent is required to store one**, checked under a row lock in the same
  transaction as the write, and withdrawing consent (`nearbyDiscoveryEnabled:
  false`) deletes the stored row in the same profile write.
- **A saved area is persistent, and nothing ages it out.** No query filters on
  `location_updated_at` any more, so a fix taken a month ago is still the origin of
  its owner's nearby search - the leftover `user_locations_freshness_idx` index was
  dropped by `0012_location_persistence.sql` because it had no reader left. Signing
  in or restarting the app never raises a permission dialog either: the three hooks
  that touch the device (`useLocationSharing`, `useCurrentFix`,
  `useGroupLocationAnchor`) *read* the existing permission on mount and *request* it
  only from a direct tap, and between taps the saved area is what the app searches
  from.
- **A refused update changes nothing.** An out-of-range or `(0, 0)` reading is a
  `validation_error` and the stored row is untouched, so a denied permission, a
  dead GPS or a failed request leaves the member exactly where they were. Profile ->
  **Your nearby area** -> **Update nearby area** is the one place that replaces it,
  and onboarding explains why a member would: they should update it when they move,
  or when they want to be found in a different local community.
- **Changing where I am changes nothing else.** A group's or an event's anchor is
  its own row in its own table, written only by an explicit tap in the form that
  names the place, and no location write reads `group_locations` or
  `event_locations`. Memberships are never filtered by location, distance or
  interest: `GET /api/groups/mine` takes only `limit`/`offset` and returns every
  active membership wherever the group is anchored, so moving cannot make a
  member's groups disappear.
- **Coordinates are rounded to 4 decimal places (~11 m)** before storage, so even
  the database does not hold a precise position.
- **A distance appears only when both sides consented** to nearby discovery and
  both hold a saved area; otherwise it is `null`, which the UI renders as
  "distance unavailable" rather than zero.
- **Distances are rounded to 50 m** before they leave the API, so repeated
  searches cannot be averaged back into a position.
- **The search origin is never client-supplied**: it is read from the caller's own
  location row, which is what makes "who is near this address?" unanswerable.
- **Identity always comes from the token.** No route accepts a user id, so a
  crafted body cannot read or move another member's data - also asserted by the
  smoke test.
- **Spatial queries are indexed**: a bounding box (`MBRContains`) narrows the rows
  through the SPATIAL index, and the exact `ST_Distance_Sphere` test runs
  afterwards. Measured on this server: `type=range`, `key=user_locations_location_sx`.
- **A group's location belongs to the group.** It lives in its own table, is written
  only from an explicit tap in the group form, and is never read from the creator's
  `user_locations` row - so creating a group cannot leak where its owner is. A nearby
  search returns a rounded distance and nothing else; a member list never carries the
  eligibility value, so an administrator cannot learn it either.

## Testing and verification

### The backend

```bash
cd backend
npm run typecheck      # tsc --noEmit
npm run db:check       # connectivity + schema + UTC session
npm run db:status      # migration state, including edited files
npm run dev            # in one terminal
npm run smoke          # in another: 772 end-to-end behaviour checks
```

`npm run smoke` (`src/tools/smoke.ts`) drives the real HTTP surface and asserts
*rules* rather than shapes, because the API is the security boundary now:

| Group | Examples of what it proves |
| --- | --- |
| Health & config | `/health/db` reports MySQL 8.0.35 and a `+00:00` session, and leaks no credential |
| Registration | Weak, common and mismatched passwords and a non-allow-listed redirect are refused |
| Confirmation | The emailed link redirects into the app; the token cannot be used twice |
| Sign-in guards | An unconfirmed account, a wrong password and an unknown address are distinguishable only where they should be |
| **Phone number + password** | Registering stores a scrypt hash rather than the password, leaves `phone_verified_at` NULL and creates the profile row in the same write; the number is claimed once (a second registration is `phone_taken` and one row remains); an invalid number is `phone_invalid` and a request with neither a number nor an address is a `validation_error`; a wrong password and an unknown number answer identically; the password rules (minimum length, the common list, the member's own name, the member's own number) apply here too; the session it opens survives a restore, renews, and stops working the moment it is signed out; the account can create a group and an event like any other; and a phone-only account answers `password_not_set`, is never given a password, and cannot be claimed by re-registering its number |
| **Phone sign-in** | A request answers 202 with a *masked* number and never the code; the code is read back from `.otp-outbox` and proves the stored value is a keyed hash rather than the code or its SHA-256; a wrong code counts down attempts and the fifth ends the challenge; the correct code creates the account, reports `isNewAccount`/`onboardingRequired`, and yields a session that refreshes, rotates, refuses a replay and is revoked by sign-out; the same code cannot be used twice; a second request retires the first; the resend cooldown and the 5-per-hour cap both refuse with `retryAfterSeconds`, and a superseded request still counts towards the cap; an expired code is `otp_expired`; a disabled account is only named after the code matches; too-long country codes, leading zeros and short numbers are `phone_invalid`; no People payload carries a phone field; bridging an existing email account keeps its id, email and finished profile |
| Profile | Validation, the interest replace-all, and that an injected id cannot re-target the write |
| Interests | The curated catalogue (≥120 interests, 15 categories) arrives grouped and de-duplicated, and the ids Phase 5 names (UPSC, DSA, anime, hiking) are present |
| Location | Out-of-range and `(0, 0)` readings refused, the 10 s throttle, rounding to ~11 m, and that *no* endpoint returns a coordinate; **an area saved a month ago is still the origin of a nearby search**, because the 24-hour rule is gone; a refused update leaves the saved row exactly as it was; replacing the area moves no group or event anchor, keeps the membership, and My groups returns the same memberships whatever selections are passed to it; switching nearby discovery off deletes the area and nothing else; the foreign key cascades it when the account goes |
| Discovery | Ranking by shared interests, the radius boundary at 1 km / 2 km, filters, and that search is not radius-limited |
| Groups | Ownership is a real row; a duplicate join makes no second row; nearby results are inside the radius with a rounded distance and no coordinates; a 0.01° east shift measures ~1 km (axis order); an unlocated group is never "nearby" and no anchor is copied from the caller; public joins are immediate, private ones pending; a member cannot approve or promote; an administrator cannot edit, archive or touch roles; a removed member cannot re-join; a rejected request cannot be re-sent; restricted audiences exclude the ineligible from discovery and from joining; the eligibility value never appears in a public payload or a member list; archiving refuses joins and edits |
| Access control | A private profile is 404 for everyone else and readable by its owner; withdrawing consent deletes the stored fix and refuses both location writes and nearby search |
| Interest matching | A group keeps the interest its owner picked, and it is really in the column; an id outside the catalogue is refused; a patch that omits the interest leaves it alone while an explicit `null` clears it, and only the owner may change it; an interest match outranks 1.1 km of distance while distance still orders two groups that both match; `matched=true` drops a group standing at the viewer's own position that shares nothing while keeping a matching one 1.1 km away; the match follows the *reader* (a second viewer matches a different group); `interest=` is an OR and an unknown id filters everything out rather than erroring; matching does not defeat the radius; members who share an interest are kept and members inside the same radius who share none are dropped, with `sharedInterestIds` naming exactly the overlap |
| Sessions | Rotation, replay revoking the whole family, immediate revocation after sign-out, and idempotent logout |
| Password recovery | Only the newest link works, a rejected password does not burn the link, and a reset revokes open sessions |
| Events | An event is a real row with a UTC start/end; the anchor is stored longitude-first; a past start, a backwards window, a zero capacity and a half-sent location are refused; a client-supplied creator id changes nothing; a nearby result is inside the radius with a rounded distance and no coordinates; an unlocated event is listed but never "nearby"; a private group's event is a 404 for a non-member and leaks through no listing, group filter, guest list or Going list; a pending request grants nothing, an approved member gets access, and a removed member keeps the RSVP row but loses the read; an ineligible member is refused with `audience_not_eligible`; three simultaneous RSVPs for two places accept exactly two; a duplicate RSVP makes no second row; cancelling keeps the row; a cancelled or ended event refuses RSVPs and leaves every listing; an archived group closes its events; only the creator or a group owner/administrator can edit or cancel |
| Disabled accounts | Access tokens, sign-in, refresh and recovery all refuse a disabled account; re-enabling restores sign-in |
| **Unified event feed** | The feed requires a session and an unknown `response=` is a validation error; an active member sees their group's upcoming event, each row carries its `groupId` and reports `viewerRsvpStatus: null` before any answer; an unanswered event is in Needs response and not in Going; a private group's event is a 404 for a non-member *and* for a pending applicant and appears in neither feed; a member of no group gets an empty feed; a standalone event is still readable by id but is not part of the group feed; a cancelled event leaves the feed and the group's own upcoming list and can no longer be answered; an ended event leaves the feed and answers `event_ended`; any active member may host for their group while a non-member is refused with `forbidden` |
| **RSVP answers** | `PUT /api/events/:id/rsvp` stores `not_going` with `cancelled_at IS NULL`, and that row is the one that changes to `going` rather than a second row appearing; a declined event does not count as attendance (`goingCount` stays 0), leaves Needs response, appears under Not going and stays in All upcoming; answering Going twice is idempotent, with one row and a count of 1; `DELETE` reports `cancelled`, frees the place and returns the event to Needs response without listing it under Not going; `cancelled` in the body is `validation_error` - withdrawing is not an answer this endpoint accepts - as is an unknown status; Not going to a *full* event succeeds, while moving that answer to Going is refused with `event_full` and leaves `not_going` in place; the count is the database count, not a client value |
| **Group chat over HTTP** | Chat history requires a session; a non-member is refused with `forbidden` on both read and write, and so is a pending request on a private group; an unknown group id is a clean 404; a member posts and gets 201 with the committed id, the body, a 36-character id, a `Z` UTC timestamp, the sender's display name and `isYou: true` for the author, while another member's read of the same row says `isYou: false`; the row really is in MySQL, filed against the group with the session's member as sender - and a `senderId` in the request body never reaches it; no message payload carries a coordinate, an email or a phone number; whitespace-only and 1001-character bodies are `validation_error`; a page is exactly the requested size and reports `hasMore` with a 36-character cursor, the first page ends at the newest stored message, the older page continues where the first stopped without repeating a row and is genuinely older, and a cursor that is not in this conversation is a validation error rather than an empty page; a repeated `clientMessageId` resolves to the same message; a removed member can neither read nor post, and the messages they already wrote stay in the history and remain readable to the group; an archived group's history stays readable while new messages are refused with `group_archived` |
| **Group chat over Socket.IO** | Two members each open a real connection to the running API; a member joins the group room through an acknowledgement, while a non-member is refused with `forbidden` and an archived group with `group_archived`; a message sent over the socket is acknowledged with the committed row, arrives at the *other* member's socket as `message:created` with the same id, and is already in MySQL by then; a `senderId` in the socket payload is ignored exactly as it is over HTTP; after the member signs out, the next socket send is refused with `session_expired` and nothing is written for it |
| **Message budget (both transports)** | The allowance is reported in the `RateLimit` headers: an HTTP post drops it by one and two socket sends drop it by the same two, because there is one counter rather than one per transport; a burst sent 20 at a time (wider than the connection pool) commits exactly the rest of the allowance, and a parallel burst past the ceiling is refused in full rather than partially; the refusal is `rate_limited` with `retryAfterSeconds` inside the window, `Retry-After` on the HTTP answer, and the same code, wait and sentence in the socket acknowledgement; exactly the accepted messages are in MySQL afterwards, so a refused submission writes nothing; the refused sender keeps its connection *and* its room; and another member's untouched allowance still lets them post |
| **Account lifecycle** | Changing the password needs the current one, keeps this session and revokes every other; closing the account needs the exact word `DELETE` and the right password, and refuses an account with no password (`password_not_set`) and one that still owns a group with other active members (`ownership_transfer_required`, naming the groups) - while leaving the refused account signed in and untouched; the deletion then archives the groups it owned, cancels its scheduled events and removes the messages, memberships, events and sessions with the account row, so the old access token answers `session_expired` and the address registers again |

It creates accounts named `smoke-<run id>-*@unihood.invalid` (a reserved domain)
and phone numbers under the unassigned `+999` country code, deletes them - and
everything cascading from them - on the way out, and reports a
clear note if a request came back `429` from the *middleware* (the deliberate
per-number `otp_throttled` refusals and the one message-budget refusal are part of
the checks and are not counted). A run killed mid-way can be tidied up with:

```bash
npm run smoke:clean
```

It needs `EXPOSE_DEV_TOKENS=true` and `MAIL_TRANSPORT=log` (the development
defaults) so it can finish the email flows without a mailbox, and - since Phase 5 -
`OTP_TRANSPORT=log` and a readable `backend/.otp-outbox`, because that directory is
where it reads the codes from. Since Phase 7 it also opens **real Socket.IO
connections** to the running API, so `npm run smoke` proves the live channel rather
than only the HTTP routes that back it. It makes a few hundred requests through the
auth bucket, which is why the development `AUTH_RATE_LIMIT_MAX_REQUESTS` is 900
rather than the 40 a person would never notice; and one section deliberately spends a
whole member's message budget (`MESSAGE_RATE_LIMIT_MAX_REQUESTS`, 300 writes) over
the socket, so a run is sized for the development `MESSAGE_RATE_LIMIT_*` values too.
Two runs inside one 15-minute window will exhaust the auth bucket - the summary says
which bucket to raise, and restarting the API resets the counters with it.

### The mobile app

```bash
npm run typecheck                      # tsc --noEmit
npm run lint                           # expo lint (eslint-config-expo)
npx expo export --platform web         # proves the bundle builds end to end
npm run doctor                         # expo-doctor
```

The export matters most for this kind of refactor: it compiles every route and
screen, so a screen still importing a removed module fails the build rather than
failing at runtime on someone's phone.

## Deploying

- **Put the API behind TLS.** `API_PUBLIC_URL` must be the public HTTPS origin,
  because it is what the links inside emails are built from; the app's
  `EXPO_PUBLIC_API_BASE_URL` is the same origin.
- **Set `NODE_ENV=production`.** That forces `EXPOSE_DEV_TOKENS` off, so no
  single-use link is ever returned in a response body, and stops the server
  echoing development detail.
- **Add a real mail transport when the time comes to invite people**
  (`MAIL_TRANSPORT=smtp` plus the `SMTP_*` values). Nothing to configure for local
  development, where the messages are written to `backend/.mail-outbox` - but with
  the `log` transport no member beyond this machine can confirm an address.
- **Treat `JWT_ACCESS_SECRET` as a secret** (a secret store or the platform's
  environment), not a file in the image.
- **Give the app user only what it needs**: `unihood_app` owns one schema. The API
  does not need `SUPER`, `GRANT` or `FILE`.
- **Back up the schema**, and test a restore: this database now holds the only
  copy of every account.
- **Rate limits are in-process.** They are per-IP and per-Node-process, which
  matches a single instance. Behind a load balancer with several instances, move
  the counters to a shared store (Redis, or a rate-limiting proxy) and trust
  `X-Forwarded-For` accordingly.
- **Set `CORS_ALLOWED_ORIGINS`** to the web build's origin instead of `*` if the
  web app is deployed.
- **App builds:** the app's own scheme (`unihood://`) is what `app.json` -> `scheme`
  registers, and the backend's `ALLOWED_REDIRECT_SCHEMES` must include it. Since
  Phase 5 the only links the API ever redirects are the *legacy* email ones
  (`/auth/verify-email`, `/auth/reset-password`), which nothing in the app issues
  any more - but a deployment that keeps old accounts alive should keep the scheme
  allow-list in step with them.

## What changed in this phase

Replacing Supabase with an API this repository owns touched both halves:

**Removed**

- `supabase/` - the four Postgres migrations (their mapping is described in the
  headers of `backend/migrations/0001..0004`), and the `@supabase/supabase-js` /
  `react-native-url-polyfill` dependencies.
- `src/lib/supabase.ts` and the PostgREST-shaped row mapping in every repository.

**Added on the mobile side**

| File | Why |
| --- | --- |
| `src/lib/apiClient.ts` | The single HTTP client: base URL, the persisted session, single-flight token renewal, and the `ApiError` contract |
| `src/lib/errors.ts` (rewritten) | `ApiError` / `NetworkError` / `BackendNotConfiguredError` and the one place that turns them into a sentence (the Postgres/PostgREST code maps are gone) |
| `src/lib/env.ts` (rewritten) | `EXPO_PUBLIC_API_BASE_URL` instead of the two Supabase values |
| `src/features/auth/authApi.ts` (rewritten) | The `/api/auth/*` calls, including the token-based reset |
| `src/features/auth/deepLink.ts` (rewritten) | `?verified=1` and `?mode=recovery&token=…` instead of a PKCE code |
| `src/features/auth/AuthProvider.tsx` (rewritten) | Session from the client's subscription, the reset token, and `emailVerified` |

**Behaviour that changed, deliberately**

- Sign-up **always** requires the emailed confirmation before sign-in, because the
  API decides that, not a dashboard setting.
- A password reset no longer creates a session: it carries a single-use token,
  revokes every session on the account, and ends at the sign-in screen.
- The interest catalog, the people list and the profile row all come from the API,
  so their ordering and field names are the server's.
- Distances, consent and the location throttle are now enforced by the API rather
  than by database security definer functions - same rules, one process away.

The screens changed very little on purpose: they read `useAuth()` and the
repositories, so replacing the backend was mostly a data-layer rewrite plus the
two auth-flow screens (`reset-password`, `auth/callback`) whose contract really
did change.

### And then, Phase 3: persistent groups

Groups moved off the in-app catalogue and into MySQL.

**Added on the backend**

| File | Why |
| --- | --- |
| `migrations/0006_groups.sql` | `groups`, `group_locations`, `group_memberships`, and `profiles.group_eligibility_gender` |
| `src/domain/groups.ts` | The category, visibility, audience, role, status and eligibility vocabularies, and the one eligibility rule |
| `src/services/groupService.ts` | The only code that knows the group tables: discovery, creation, editing, archiving, membership, requests and roles |
| `src/routes/groups.ts` | The HTTP surface, with every path parameter, enum and page size validated |

**Added on the mobile side**

| File | Why |
| --- | --- |
| `src/features/groups/groupRepo.ts` | Every group call, with wire-shape mapping that never lets an unknown server value reach a component |
| `src/features/groups/GroupForm.tsx` | The create/edit form, including the explicit "use my current location" control |
| `src/features/groups/useGroupLocationAnchor.ts` | The one-shot device read for a group's own anchor (deliberately not the profile's location hook) |
| `app/group/manage/[id].tsx`, `app/group/edit/[id].tsx` | Membership management, and the owner's settings and archiving |
| `app/create/group.tsx` | The create-group form, which replaces the Phase 1 placeholder |

**Behaviour that changed on purpose**

- **Joining is a server operation.** The Groups tab, a group's page and the
  profile's "Your groups" all read MySQL now, and a card shows `Request pending`
  where it used to toggle a local flag.
- **A private group is a real flow.** Requests, approval, decline and withdrawal are
  endpoints, and the owner or an administrator decides.
- **The Events tab was untouched in Phase 3** and still read its in-app catalogue,
  including the Phase 1 group names for the "hosted by" label; the two are joined up
  in Phase 4.

### And then, Phase 4: persistent events

Events moved off the in-app catalogue and into MySQL, and the mock fixtures that only
existed to feed that catalogue were deleted with it.

**Added on the backend**

| File | Why |
| --- | --- |
| `migrations/0007_events.sql` | `events`, `event_locations`, `event_rsvps` |
| `src/domain/events.ts` | The category, status and RSVP vocabularies, the field limits and the window rule |
| `src/services/eventService.ts` | The only code that knows the event tables: discovery, creation, editing, cancelling, RSVPs, capacity and the guest list |
| `src/routes/events.ts` | The HTTP surface, with every path parameter, enum and page size validated |

**Added on the mobile side**

| File | Why |
| --- | --- |
| `src/features/events/eventRepo.ts` | Every event call, with wire-shape mapping that never lets an unknown server value reach a component |
| `src/features/events/EventForm.tsx` | The create/edit form: one category, local date/time text, an explicit venue anchor and a group picker |
| `app/event/edit/[id].tsx` | The organiser's settings, and the confirmed cancelling flow |
| `app/create/event.tsx` | The create-event form, which replaces the Phase 1 placeholder |

**Removed**

- `src/features/events/mockEvents.ts`, `src/features/events/eventFilters.ts` and
  `src/features/groups/mockGroups.ts` - the fixtures the Events tab used to read.
- The mock-only lists in `src/store/appStore.tsx` (`joinedGroupIds`, `goingEventIds`,
  `toggleRsvp`, ...): membership and RSVPs are server rows now, so a local copy would
  only be a second, stale answer.

**Behaviour that changed on purpose**

- **RSVP is a server operation.** The Events tab, an event's page, the profile's
  "Going to" list and a group's "Upcoming events" section all read MySQL now.
- **A full event is a real state**, decided under a lock, and the app shows it instead
  of pretending the tap worked.
- **A private group's event is genuinely private**: the same predicate that hides the
  group hides its events, so a shared link leads nowhere for anyone outside it.

### And then, Phase 5: phone sign-in and onboarding

The email/password screens were replaced by a phone number and a one-time code, and
first-run onboarding grew from one form into three saved steps backed by a
catalogue of ~150 interests.

**Added on the backend**

| File | Why |
| --- | --- |
| `migrations/0008_phone_otp.sql` | Nullable `email`/`password_hash`, `phone_e164` + `phone_verified_at`, and the `otp_challenges` table |
| `migrations/0009_interests_catalogue.sql` | `interests.category` (with a CHECK on the fifteen groups) and the idempotent curated seed |
| `src/domain/phone.ts` | E.164 normalisation, validation and masking - the one place a phone number's shape is decided |
| `src/lib/otp.ts` | CSPRNG code generation, the keyed hash, and the constant-time comparison |
| `src/lib/otpTransport.ts` | The transport interface: `log` (development, writes to `.otp-outbox`) and `sms` (a provider URL + token) |
| `src/services/otpService.ts` | The whole code lifecycle: issue, cooldown, hourly cap, supersede, verify, attempts, find-or-create the account |
| `src/tools/linkPhone.ts` | `npm run phone:link` - the explicit bridge that gives a legacy email account a number |

**Added on the mobile side**

| File | Why |
| --- | --- |
| `app/(auth)/sign-in.tsx` (rewritten) | Number → code, with a dialling-code picker, a resend countdown and per-code error handling |
| `app/onboarding.tsx` (rewritten) | Three steps that save as they go: identity + optional eligibility, interests, nearby |
| `src/features/onboarding/InterestPicker.tsx` | Search, category rail, grouped chips, a selection counter and the cap |
| `src/data/interestCategories.ts` | The fifteen groups as labels and the product's reading order |
| `src/data/phoneCountries.ts` | The dialling-code picker's data (the API accepts any valid E.164 number) |
| `src/features/location/useCurrentFix.ts` | Read one coarse fix and let the member confirm it, before anything is stored |

**Removed**

- `app/(auth)/sign-up.tsx`, `verify-email.tsx`, `forgot-password.tsx`,
  `reset-password.tsx`, `auth/callback.tsx`, plus
  `src/features/auth/deepLink.ts` and `AuthRouteWatcher.tsx` and the
  `emailVerified` / `passwordRecoveryPending` state in `AuthProvider`. Verifying a
  number is registering, so there is nothing for those screens to do, and no reset
  link to come back from. The API's email endpoints and browser pages stay for
  legacy accounts.

**Behaviour that changed on purpose**

- **Onboarding is resumable.** Each step writes the profile with `complete: false`;
  only the last one finishes it. A member interrupted at step two comes back to a
  form with their name and interests already in it, instead of an empty one.
- **`PUT /api/profile/me` gained an optional `complete`**, defaulting to `true`, so
  every other caller keeps the old promise and `profile_completed` cannot be
  switched back off by editing a profile.
- **The interest catalogue is the product's**: ~150 curated interests in 15 named
  groups, seeded by an `ON DUPLICATE KEY UPDATE` that never touches
  `profile_interests`, so re-running it adds nothing and no member's selection is
  rewritten. The thirteen ids from migration 0002 keep their ids and their names.
- **`users.display_name` is kept in step with the profile** it names, so the
  account-level copy can no longer disagree with what other members see.
- **Nothing about sessions changed.** Refresh rotation, replay detection, the
  per-account session cap, immediate revocation and sign-out all behave exactly as
  they did - which the smoke test now proves for a code-based session too.

### And then, Phase 6: interest-matched discovery

Discovery stopped being only "what is near me". A group now carries **one primary
interest**, chosen from the same catalogue members pick their own interests from,
and both Nearby listings rank a result whose interest the viewer shares **above**
one that merely happens to be closer. The match is computed by the server, from the
viewer's stored interests, so it cannot be claimed by a client.

**Added on the backend**

| File | Why |
| --- | --- |
| `migrations/0010_group_interest.sql` | Nullable `groups.interest_id` (`VARCHAR(40)` to match `interests.id`, FK with `ON DELETE SET NULL`) and `groups_interest_idx (interest_id, archived_at)` |
| `src/domain/groups.ts` | `MAX_GROUP_INTEREST_FILTERS`, the same bound `peopleService` already used |
| `src/services/groupService.ts` | The interest on create/edit (`resolveInterestId` validates it against the catalogue), the `interest_id IN (…)` and "one of mine" filters, and the `matched_interest` ordering key that sits in front of the distance |
| `src/services/peopleService.ts` | `sharedInterestIds` on every row (the `shared` CTE now concatenates the overlapping ids) and the `matchSharedInterests` predicate |
| `src/routes/groups.ts`, `src/routes/people.ts` | `interest=` and `matched=` (an enum of `true`/`false`, never `z.coerce.boolean()`), plus `interestId` on the group draft and patch |

**Added on the mobile side**

| File | Why |
| --- | --- |
| `src/features/groups/GroupForm.tsx` | The primary-interest picker: one chip per interest *the owner has already picked*, plus a "No interest" chip |
| `app/(tabs)/groups.tsx` | Nearby / My groups as the switch, the viewer's own interests as chips, and a "Matched to my interests" chip |
| `app/(tabs)/index.tsx` | The same match chip for people, and an empty state that offers to drop the match rather than changing view |
| `src/features/groups/GroupCard.tsx`, `src/features/people/PersonCard.tsx`, `app/person/[id].tsx` | The matched interest is the tinted tag, so the ranking is visible rather than merely claimed |
| `src/types/group.ts`, `src/types/person.ts` | `interestId` on a group and its draft, `sharedInterestIds` on a person |

**Behaviour that changed on purpose**

- **"All groups" is no longer a segment on the Groups tab.** A segmented control
  answers one question, and that screen's question is now "what is near me and
  matched to me". The whole directory is still one tap away - as an explicit
  banner with a way back - which is what keeps it an escape hatch instead of a
  hidden state, and what keeps a member with no fresh fix able to browse.
- **People's two segments are Name and Skill, not Nearby and Everyone.** The nearby
  search is the premise of that screen rather than a mode of it, so the switch only
  decides what the words in the box are compared against - sent to the API as `by`,
  so a name search never floods the list with interest matches and a skill search
  never answers with a person. **Skill** also suggests from the whole interest
  catalogue, not from the member's own picks: the API matches those labels and slugs,
  so a skill nobody around them has chosen yet is still a question the screen can ask.
  `mode=search` stays in the API for a caller that wants the same filters with no
  radius, but the app never sends it: a member with no saved area gets the way to set
  one instead of a list of strangers.
- **The match is read, never trusted.** `matched=true` compares against the
  caller's own `profile_interests` rows inside the query. There is no
  "interests" argument to lie with, which is why the mobile chips are built from
  the viewer's own interests rather than from the whole catalogue.
- **An interest is a ranking signal, not a requirement.** A group with
  `interest_id IS NULL` is still listed everywhere; it is ranked after the
  matches, and it disappears only from a listing the viewer explicitly filtered
  by interest.
- **Distance remains the second key, and never a hidden filter.** Matching does
  not widen the radius: `matched=true&radius=1000` returns only the matching group
  inside 1 km.
- **The pair of values is validated, not coerced.** `matched=` accepts `true` and
  `false` only - `matched=yes` is a `validation_error`, because `Boolean('0')` is
  `true` and a query string is always text.

**What this deliberately does not do**

- No second or third interest per group. One primary interest is what the ranking
  and the filters are built on; a group that wants to say more can say it in its
  description, and a member can still filter the directory by *their* interests.
- No interest-based ordering in the alphabetical directory listing. A directory is
  something people scan, so only the Nearby ranking rewards a match.


### And then, Phase 7: a group chat, "Not going" as an answer, and one feed for every group's events

Two things a member could say were still not being kept. A group's conversation
existed only while the screen was open, and "I have not looked at this yet" and "I
am not coming" were the same row in the database. Phase 7 stores both, and then
closes the loop on the Events tab: the calendar a member sees is now their
**groups'** calendar, and every event on it can be answered Going, Not going, or
withdrawn.

**Added on the backend**

| File | Why |
| --- | --- |
| `migrations/0011_group_chat_and_rsvp_responses.sql` | `group_messages` - an immutable id, the group, the sender, the body, a nullable `client_message_id` and a UTC `created_at`; `UNIQUE (group_id, sender_id, client_message_id)` turns a double tap into the same row; one index serves both chronological pages; a `CHECK` holds the body between 1 and 1000 characters. Plus a third `event_rsvps.status`, `not_going`, added by re-declaring one `CHECK`. **No row is rewritten** - `going` and `cancelled` keep exactly the meaning they had, and `cancelled_at` stays `NULL` for a decline |
| `src/domain/chat.ts` | `MESSAGE_MAX_LENGTH` / `MESSAGE_MIN_LENGTH`, the page bounds, `REALTIME_PATH`, `REALTIME_EVENTS`, `groupRoom()` and `REALTIME_SESSION_SWEEP_MS` - the vocabulary the migration, the zod schemas, the service and the socket layer all read from, in the spirit of `domain/groups.ts` |
| `src/services/chatService.ts` | `listGroupMessages` - a keyset page served oldest-first, with `isYou` and the sender's display name *derived* from the stored row rather than stored again - and `sendGroupMessage`, the single write path, which is what makes the socket and the HTTP route the same feature |
| `src/realtime/socket.ts`, `src/realtime/hub.ts` | `attachRealtime` binds Socket.IO to the API's own `http.Server` at `/realtime` and spends the member's message budget on every `message:send` before it reads the payload; the hub is what pulls a member's sockets out of a room when they leave, are removed, or archive the group |
| `src/middleware/messageLimit.ts` | The per-member message budget *both* transports spend, the one refusal they both answer with, and the HTTP middleware that reports it in draft-7 `RateLimit` headers - the file that makes "one allowance, two transports" a property of the code rather than a promise in a comment |
| `src/routes/groups.ts` | `GET` / `POST /api/groups/:id/messages`, the `POST` spending the caller's message budget after `requireAuth` and before the body is parsed |
| `src/services/eventService.ts`, `src/routes/events.ts` | `listGroupEventFeed` - the same event query under four response predicates - and `setEventRsvp`, which now accepts `going` and `not_going` and takes capacity under `FOR UPDATE` |
| `src/config/env.ts` | `MESSAGE_RATE_LIMIT_MAX_REQUESTS` and `MESSAGE_RATE_LIMIT_WINDOW_SECONDS`, its own ceiling and window, because a POST is not a GET and neither is an OTP |
| `src/tools/smoke.ts` | The answers, the four feed states, chat over HTTP *and* over a real socket connection, and the shared message budget proved exhausted from both |

**Added on the mobile side**

| File | Why |
| --- | --- |
| `app/group/chat/[id].tsx` | The room: the group's history, the composer, and a live/offline indicator the screen never hides |
| `src/features/chat/chatRepo.ts`, `chatSocket.ts`, `useGroupChat.ts`, `ChatThread.tsx` | The HTTP history, the socket, the state that merges them (optimistic send, dedupe by `clientMessageId`, reconnect) and the presentation |
| `src/types/chat.ts` | The message, page and connection-state types, `mergeChatMessages`, and `chatBodyProblem` - the length rule the composer applies *before* sending |
| `app/(tabs)/events.tsx` (rewritten), `src/features/events/eventRepo.ts`, `src/types/event.ts` | The unified feed with its four filters, `viewerRsvpStatus` on every row, and `fetchEventFeed` / `setEventRsvp` / `cancelEventRsvp` |
| `app/event/[id].tsx`, `src/features/events/EventCard.tsx` | **Going** and **Not going** as two separate answers, and the member's own response shown on the card |
| `src/lib/routes.ts`, `src/features/events/EventForm.tsx`, `app/create/event.tsx` | `routes.groupChat(id)`, and `requireGroup`: an event created from the Events tab now belongs to one of the member's groups |


**Behaviour that changed on purpose**

- **"Not going" is an answer; withdrawing is not.** A decline is stored as
  `not_going` with `cancelled_at IS NULL`, so it can be filtered, counted and
  changed back; a withdrawal stays `cancelled`, which is "no answer right now".
  `PUT /api/events/:id/rsvp` accepts only `going` and `not_going` - asking it for
  `cancelled` is a `validation_error`, because withdrawing is `DELETE`. Keeping the
  two apart is exactly what lets "Needs response" mean *unanswered* rather than
  "unanswered or declined".
- **Only Going takes a place.** A decline never consumes capacity, and switching a
  decline to Going on a full event is refused with `event_full` *and leaves the
  decline in place* - the member keeps the answer they had rather than silently
  losing it to a failed upgrade.
- **The Events tab is the member's groups' calendar.** The feed reads
  `upcoming`, `needs_response`, `going` and `not_going` as four predicates over one
  query, and every row carries its `groupId` and the viewer's own response, so the
  screen never has to reconcile two lists - or ask the client what it thinks the
  answer was.
- **An event created from the Events tab needs a group.** The form drops "No group"
  there (`requireGroup`), because an event nobody's group can see is an event the
  unified feed cannot answer for. The group page keeps the standalone option, and so
  does editing an event that is already standalone.
- **The socket is an optimisation, not a second API.** `message:send` calls the
  same `sendGroupMessage` the HTTP route calls; joining a room grants no
  permission (every action re-checks the session, and a socket left in a room still
  cannot write to it); and `GET /health` reporting `realtime: false` is not a
  failure - the history, the send and the answer all work over HTTP alone.
- **What the client sends is never what is stored.** A `senderId` in either the HTTP
  body or the socket payload is ignored; the sender is the authenticated session, and
  the id, the timestamp and the `isYou` flag all come from the stored row.
- **A former member keeps their words and loses their access.** Nothing deletes a
  message when a member leaves, so the group's record stays true; that same member
  simply cannot read the history they are no longer part of.
- **Messages are rate-limited on their own bucket, per member.**
  `MESSAGE_RATE_LIMIT_MAX_REQUESTS` (300 writes per 15-minute
  `MESSAGE_RATE_LIMIT_WINDOW_SECONDS` window by default) against the auth bucket's 900,
  because typing quickly is normal behaviour and the point is to bound a runaway
  client, not to shape a conversation. The HTTP route and the socket draw on that one
  allowance (`backend/src/middleware/messageLimit.ts`), so the transport a client picks
  is not a way around it - and both answer the same `rate_limited` refusal with the
  same `retryAfterSeconds`.

**What this deliberately does not do**

- **No per-event chat.** The conversation belongs to the group, so an event's
  discussion happens where the group already talks; a second thread per event would
  split the room in two.
- **No unread counts or presence.** "Who is online" and "3 new" are their own state
  machine, and the chat screen's live/offline indicator already answers the question
  a member actually asks.
- **No notification fan-out.** A message arrives on the socket while the app is
  open, or from the history when it is next opened; there is no push, email or
  badge, and nothing pretends otherwise.
- **One message budget, in one process.** The per-member counters live in the API's own
  memory, so the limit is exactly as strong as the deployment is wide: a restart forgets
  every window (which is also why a smoke run gets its allowance back when the API is
  restarted), and two instances behind a load balancer would each enforce their own
  ceiling - a client would get one budget per instance, and could hop between them.
  Distributed enforcement needs a shared store keyed by user id and is deliberately not
  claimed here; the honest reading of this feature is "one process, one budget per
  member, refilled every 15 minutes". What it *does* bound is the case that mattered: a
  client in a loop, over either transport, on any number of connections - and it does so
  without a write per message, which is the cost a stored counter would add to every
  send.
- **The budget is spent by an attempt, not by a stored message.** A body that fails
  validation, a group the member has since been removed from, and a genuine message all
  cost one unit, and a refusal is not refunded. That is the same order the per-IP buckets
  already had (they are middleware, ahead of the route), and it is what keeps the limit
  from becoming a probe for what is and is not allowed.
- **No backfill.** `group_messages` begins empty when the migration runs. There is no
  invented history - the record starts with the first message sent after it.
- **No change to the RSVP history.** Migration 0011 rewrites one `CHECK` and not one
  row, so every `going` and `cancelled` answer recorded before this phase still means
  what it meant; there is nothing to reconcile and nothing to reverse.

### And then: a phone number and a password

Signing in with a one-time code was right for a demo and wrong for a product: a code
costs money to send, needs a provider that does not exist yet, and ties an account to
whichever device holds the SIM. The credential the app asks for is now a **name, a
phone number and a password**, on one screen that carries both halves of the flow -
sign in, and create the account.

**What changed**

| File | Why |
| --- | --- |
| `backend/src/services/authService.ts` | `registerWithPhone` - unique number, scrypt hash and the profile row in one transaction, then a session - and `loginWithPhone`, which verifies in constant time, answers `password_not_set` for an account that has no password, and upgrades an old hash on the way in |
| `backend/src/routes/auth.ts` | `/register` and `/login` take **either** `{ phone, password }` or the original `{ email, password }`, as a strict union: a request with neither is a `validation_error`, and one with both is refused rather than having a field silently ignored |
| `backend/src/lib/password.ts` | `assertPasswordAcceptable` also refuses a password built out of the number it signs in with |
| `backend/src/lib/errors.ts` | The `password_not_set` code |
| `src/features/auth/authApi.ts` | `registerWithPassword` / `signInWithPassword`, and `MIN_PASSWORD_LENGTH` so the form mirrors the API's floor |
| `app/(auth)/sign-in.tsx` (rewritten) | Sign in / Create an account on one screen, with password and confirmation; `/welcome` opens it on either mode, and no screen offers a one-time code |
| `app/(auth)/welcome.tsx` | The first screen offers the only two things a visitor can do - create an account, or sign in - and both open `/sign-in` (the second with `?mode=create`) |
| `backend/src/tools/smoke.ts` | 39 checks for the new credential (667 → 706) |

**What this deliberately does not do**

- **No migration, and not one row touched.** `users.phone_e164` and the nullable
  `password_hash` have existed since migration 0008; a new account fills both, and an
  existing one keeps exactly the columns it had.
- **No password is assigned to an existing account**, and nothing marks a number
  verified that a code never proved: `phone_verified_at` is NULL for every account
  this flow creates. `npm run phone:link` remains the one explicit way to give a
  legacy *email* account a number.
- **No new provider.** The `/api/auth/otp/*` pair stays for the legacy account that
  has no password, but nothing in the app calls it: `requestPhoneOtp` /
  `verifyPhoneOtp` are exported from `authApi` and re-exported by nothing, so an SMS
  transport is only ever needed if someone calls them deliberately.
- **No password-reset screen.** There is nothing to deliver a link with - the app has
  no mail or SMS channel - so the legacy `/api/auth/forgot-password` and
  `/api/auth/reset-password` pair stays for an account that has an email address, and
  a member who forgets a password contacts whoever runs Unihood. A member-facing reset
  is its own piece of work, not a side effect of this one.
- **No password-change screen in this pass.** A change wants the current password, a
  session and its own screen; bolting it onto profile editing would have been the
  wrong shape, so it and account deletion arrived later as their own screens under
  Profile - see "And then: changing a password, and closing an account" below.
- **`phone_verified_at` is still not a gate.** It records a code that was checked and
  nothing else, so gating a password sign-in on it would lock out every account this
  flow creates.

### And then: changing a password, and closing an account

The phone-and-password pass ended with two deliberate gaps - no way to change the
password, and no way to close the account. Both are now screens under **Profile →
Account**, and both go through endpoints that re-verify the password rather than
trusting the session: a live session proves *which* account is asking, not that the
person holding the phone is its owner.

**What changed**

| File | Why |
| --- | --- |
| `backend/src/services/authService.ts` | `changePassword` - verifies the current password (running one dummy comparison for an account that has none, so the answer's timing still says nothing), refuses a new password that is the old one, hashes it, and revokes every *other* session while leaving the caller's own alone |
| `backend/src/services/accountService.ts` | `deleteMyAccount` - the order and the refusals: verify the password, refuse while an owned group still has other active members (naming them), archive an owned group nobody else is in, cancel the account's scheduled events, delete children, then the account row - one transaction, so a failure leaves the account exactly as it was |
| `backend/src/routes/auth.ts` | `POST /api/auth/change-password`, behind the same limiter as `/login` |
| `backend/src/routes/account.ts` | `DELETE /api/account`, with `{ password, confirm: "DELETE" }` as a strict body - the word is checked here as well as in the form, because the form is the convenience and this is the rule |
| `backend/src/tools/resetData.ts` | `db:backup`, `db:reset:dry`, `db:reset` and `db:restore`: snapshot the local data, verify the snapshot's SHA-256s, then clear the app tables. The schema and the interest catalogue stay, and `schema_migrations` is never touched, so a reset can never make a migration look un-applied |
| `src/features/auth/authApi.ts` | `changeMyPassword` and `deleteMyAccount`, plus the `MIN_PASSWORD_LENGTH` the form mirrors |
| `src/features/auth/AuthProvider.tsx` | `changePassword` and `deleteAccount` on the context; deleting clears the stored session *and* the profile row, so the root guard answers by returning to `/welcome` |
| `app/profile/change-password.tsx`, `app/profile/delete-account.tsx` | The two screens, both reached from Profile → Account, which gains its second row |
| `backend/src/tools/smoke.ts` | 32 checks for the two endpoints (706 → 738) |

**What this deliberately does not do**

- **No session is treated as proof of ownership.** Both endpoints want the password,
  and a wrong one is `invalid_credentials` - never a message that says which half of
  the credential was wrong.
- **No group disappears because its owner did.** A group with other active members
  blocks the deletion with `ownership_transfer_required` and names the groups, so the
  screen can offer the way to them; a group nobody else is in is archived first, so a
  member who arrives later sees an archived group rather than a missing one.
- **No password is invented for an account that never had one.** A phone-only account
  (`password_hash IS NULL`) answers `password_not_set` on both endpoints, and asking
  whoever runs Unihood is still the only way one is set.
- **No undo.** The response reports what went (`archivedGroups`, `cancelledEvents`,
  `removedMessages`), but the row is gone: the way back is the flow a new member uses,
  with the number the account released.
- **No filesystem cleanup, because there is no file store yet.** When image sharing
  adds one, the cleanup belongs after the commit in `deleteMyAccount` and has to be
  retried by whoever notices - a database row and a file can never be removed together.

