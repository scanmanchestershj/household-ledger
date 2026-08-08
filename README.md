# The Household Ledger

A static, single-page household finance/chores dashboard. Login and all data
(chores, budgets, cards, requests, etc.) are now backed by **Supabase**
(real email/password auth + a Postgres database) instead of the browser's
localStorage, so your household can sign in and see the same data from any
device.

This is a plain static site — no build step, no framework. It's just
`index.html` + `config.js`, deployable on Vercel as-is.

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Pick a name, database password, and region. Wait for it to finish provisioning (~2 min).
3. In the left sidebar go to **Authentication → Providers → Email**, and turn
   **"Confirm email" OFF**. This app expects sign-up to log the user in
   immediately, which requires email confirmation to be disabled (or you'll
   need to add extra handling for the "check your inbox" step yourself).
4. Go to **SQL Editor → New query**, paste in the entire contents of
   [`supabase/schema.sql`](./supabase/schema.sql) from this repo, and click **Run**.
   This creates the `households`, `profiles`, and `household_data` tables,
   turns on Row Level Security, and adds the `join_household` function used
   by the "Join household" invite-code flow.
5. Go to **Project Settings → API**. Copy:
   - **Project URL**
   - **anon public** key

---

## 2. Configure the app

Open `config.js` in this repo and paste in the values from step 1:

```js
window.SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
```

The anon key is safe to ship in client-side code — it's meant to be public.
Everything is actually protected by the Row Level Security policies in
`supabase/schema.sql`, which only let a signed-in user read/write their own
household's data.

---

## 3. Push to GitHub

```bash
cd household-ledger
git init
git add .
git commit -m "Household Ledger — Supabase-backed"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/household-ledger.git
git push -u origin main
```

(Create the empty repo on GitHub first at github.com/new, without a README,
then run the commands above.)

---

## 4. Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo you just pushed.
2. Framework preset: **Other** (it's a static site — no build command, no output directory needed).
3. Click **Deploy**.

That's it — Vercel will serve `index.html` directly. Every time you push to
`main`, Vercel redeploys automatically.

> If you'd rather not use the Vercel dashboard: `npm i -g vercel`, then
> `vercel` from inside the project folder.

---

## How login works now

- **New household**: the first person signs up on the "New household" tab.
  They become the household's **admin** and a `households` row + invite code
  is created for them.
- **Join household**: everyone else uses the invite code (shown to the admin
  under Admin → "Invite people to this household") to join on the "Join
  household" tab, choosing their own private password.
- **Sign in**: real Supabase Auth email/password login. Sessions persist, so
  people stay logged in across visits/devices until they log out.
- **Forgot password**: sends a real password-reset email via Supabase (make
  sure your Supabase project's email settings/SMTP are configured — the
  built-in Supabase email service works out of the box for low volume).
- Admins can promote/demote members and remove them from the household from
  the Admin tab. Removing someone revokes their access to the household's
  data but does not delete their underlying Supabase account.

## What data lives where

Everything the original app used to keep in `localStorage` (settings, users,
permissions, chores, budgets, cards, requests, etc.) is now saved as a single
JSON blob per household in the `household_data` table, synced on every
change — so it's available from any device your household members sign in
from.

## Limitations / things you may want to improve later

- Admin-initiated user actions (promote, remove, password reset) use the
  public anon key + RLS, not the Supabase service role key, so there's no
  server-side "create a login for someone else" — new members always sign
  themselves up with their own password via the invite code. This keeps the
  whole thing deployable as a static site with zero server code.
- If you turn "Confirm email" back on, sign-up/join will require the person
  to confirm their email and then repeat the sign-up/join step once signed
  in, since Supabase requires an active session to write the household/profile rows.
