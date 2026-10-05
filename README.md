# Draké store on Netlify

public/index.html            the storefront
netlify/functions/api.mjs    payment + email + tracking (runs on Netlify, holds your secret keys)
netlify.toml                 tells Netlify where things are
package.json                 one dependency (@netlify/blobs, stores orders)

## Deploy (use GitHub or the CLI; drag-and-drop does NOT deploy functions)
A) GitHub: push this folder to a repo -> Netlify > Add new site > Import from Git -> deploy
B) CLI:    npm i -g netlify-cli && npm install && netlify login && netlify init && netlify deploy --prod

## Environment variables (Netlify > Site configuration > Environment variables)
CASHFREE_ENV (sandbox / production), CASHFREE_APP_ID, CASHFREE_SECRET_KEY,
MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_FROM_EMAIL (verified sender), MAILJET_FROM_NAME, OWNER_EMAIL (optional)
After adding or changing variables, trigger a new deploy.

## Cashfree dashboard
Developers > Webhooks > add https://YOUR-SITE/api/cashfree/webhook (payment success event).

## Test locally
Copy .env.example to .env, then: npm install && npx netlify dev  (opens http://localhost:8888)

## Before real money
Prices come from the browser today. Move them to the function so the server decides the amount.
