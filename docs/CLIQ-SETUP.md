# Zoho Cliq notices for Hopper

When someone shares files with you in Hopper, the office bot sends you a direct message in Zoho
Cliq, for example:

> Arun Kumar sent you 3 files (420 MB): "Lot 7 isos for check" — saved to your Hopper Inbox

If your PC was off and the files went to the office server instead, the message ends with "on the
office server, it will appear in your Hopper Inbox when Hopper starts".

The office already has a bot for this, **Hopper Bot**, and Hopper's built-in endpoint points at
it: `https://cliq.zoho.in/api/v2/bots/spreadsheetstatus/message`. So the usual setup is one step
for the office admin: paste the bot's webhook token once (step 3) and save. Every PC reads it from
the shared office config; nobody configures the bot on their own PC. Each person only fills in
their Zoho email and subscribes to the bot (step 4).

Steps 1 and 2 are needed only to make a new bot or a new token.

## How Hopper calls Cliq

Each notice is one HTTPS request from the sender's PC:

```
POST https://cliq.zoho.in/api/v2/bots/<bot-unique-name>/message?zapikey=<webhook token>
Content-Type: application/json

{"text": "<message>", "userids": "<recipient's Zoho email>"}
```

- The endpoint and `userids` come from the Cliq REST API v2 "Post message to a bot". That page
  says `userids` takes comma-separated user IDs **or email IDs**, and sends the message to those
  subscribers of the bot.
- The `zapikey` query parameter, which carries a webhook token, comes from Cliq's "Working with
  Webhook Tokens" page. That page lists `.../bots/{bot-unique-name}/message?zapikey=...` as a
  supported endpoint.
- Hopper waits at most 10 seconds and never retries, so a Cliq outage can't flood the API. It
  sends notices one at a time and never writes the zapikey to a log.
- A failed notice never fails the share; the files are delivered either way.

## 1. Cliq admin: create a bot (only if you are not using Hopper Bot)

1. In Zoho Cliq (web or desktop), click your profile picture (top right) and choose
   **Bots & Tools**.
2. Open **Bots** and click **Create Bot**.
3. Name it `Hopper` and give it a short description, such as "File-share notices from Hopper".
   Add the Hopper icon if you like.
4. Set the access level to **Organization**, so every Dexterity user can find and subscribe to it.
5. Save. Hopper only posts messages, so no handlers are needed. Leave the default
   message/welcome handlers as they are.
6. Find the bot's **unique name**. Open the bot's chat window, then **Actions > Bot Permalink**.
   The permalink looks like `https://cliq.zoho.in/bots/hopper`, and the last part (`hopper`) is
   the unique name.

## 2. Cliq admin: create a webhook token (the zapikey), if you do not have one

1. Profile picture > **Bots & Tools** > **Webhook Tokens**. Cliq asks for two-factor
   verification, and the session lasts 15 minutes.
2. Click **Generate New Token**, label it `Hopper`, and copy the token.
   - Each Cliq user can hold at most 5 webhook tokens.
   - The token belongs to the person who generated it. If that account is deactivated or the
     token is deleted, notices stop. Consider generating it from a long-lived admin account.

## 3. Office admin: paste the token in Hopper, once

On the admin's PC, open **Settings > Office > Zoho Cliq bot**:

| Field | Value |
|---|---|
| Send a Cliq DM to each recipient… | on |
| Bot endpoint | already filled in with the office's Hopper Bot (`https://cliq.zoho.in/api/v2/bots/spreadsheetstatus/message`). Change it only for a different bot: `https://cliq.zoho.in/api/v2/bots/<unique-name>/message`. |
| zapikey | the bot's webhook token (from step 2, or from whoever made the token) |

Then **Save**. Only an office admin can change these fields.

Use the domain your Cliq account opens on. An account on `cliq.zoho.in` is in the India data
centre; use `cliq.zoho.com`, `.eu` and so on for other centres. Enter the endpoint **without**
`?zapikey=`, because Hopper adds it. Never paste the token into a message, a ticket or a document.

These values are saved to the shared office config (`office.json` on the server), so every Hopper
in the office uses the same bot with no setup on the other PCs. Anyone who can read that file can post as the bot, so keep the
folder's permissions limited to staff.

Click **Send test DM** with your own Zoho email. Hopper calls the `cliq.test` method and shows the
HTTP status. A 2xx status means it worked. These are the typical failures:

| Result | Meaning |
|---|---|
| `401 oauthtoken_invalid` | The zapikey is wrong, deleted, or from another data centre. |
| `404` / bot not found | The unique name in the endpoint is wrong. |
| 2xx but no message arrives | The recipient has not subscribed to the bot (see step 4). |

## 4. Every user: fill in your profile and subscribe

1. In Hopper, open **Settings > Profile > Email** and enter the email you use to sign in to
   **Zoho** (it may differ from your Windows login). Hopper broadcasts it to the other office PCs
   so they know where to send your notice.
2. In Cliq, search for the **Hopper** bot (or open its permalink) and click **Subscribe**.

When Hopper doesn't know a recipient's Zoho email (they never filled in their profile, and no PC
has seen their Hopper since), it skips the notice and writes a log line. The share itself still
goes through.

## What could not be confirmed from Zoho's documentation

- **Users outside the subscriber list.** The API page says `userids` "broadcast[s] message to
  dedicated bot subscribers". It doesn't say what happens to an email that isn't subscribed. Our
  assumption, which is why step 4 asks everyone to subscribe, is that the message is dropped
  silently while the call still returns success. There may be an admin setting that subscribes
  everyone automatically, but the pages we read don't mention one.
- **Webhook token combined with `userids`.** The REST page documents `bots/.../message` with an
  OAuth token (scope `ZohoCliq.Webhooks.CREATE`) and the `userids` field. The webhook-token page
  documents the same endpoint with `?zapikey=`, but doesn't mention `userids`. Using both
  together is an inference. We made one live probe with a fake token against `cliq.zoho.in`: Cliq
  read the `zapikey` and answered `401 oauthtoken_invalid`, which shows the parameter is checked
  on that host. A real token is still needed to confirm delivery end to end.
- **Success status code.** The docs don't state it. Hopper treats any 2xx as success.
- **Rate limits.** The docs list no quota for bot messages. Hopper sends one request per recipient
  per share, in sequence.
- **Menu labels** (Bots & Tools > Bots > Create Bot, access level "Organization") come from Zoho's
  help pages and a third-party guide, not from a live Cliq session. The wording in the Cliq UI may
  differ slightly.
