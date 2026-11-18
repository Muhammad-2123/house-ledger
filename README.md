# The House Ledger

A small mobile website for friends who share a home: each person enters what they
bought and what they paid, the others say whether they share in it, and at the end
of the week (Saturday – Friday) the site works out who pays whom, split equally among
the people who shared in each purchase.

## Preview mode
With `firebaseConfig = null` in `config.js` the site keeps everything in the browser
only — handy for trying it out, but each phone sees only its own data.

## Making it shared between phones (Firebase, free plan)
1. Go to https://console.firebase.google.com and create a project.
2. Build → Authentication → Get started → enable **Email/Password**.
3. Build → Firestore Database → Create database (production mode).
4. Firestore → Rules: paste the contents of `firestore.rules` and Publish.
5. Project settings → Your apps → Web app (`</>`) → copy the config object into `config.js`.
6. Authentication → Settings → Authorized domains → add `<your-github-name>.github.io`.

## Hosting
Static files only — GitHub Pages serves the repository root as is.
