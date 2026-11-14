# Hopper notices in Dexterity Connect

Hopper can send its notices to **Dexterity Connect**, the office messenger, instead of a Zoho Cliq bot:

- files, folder links and requests for files sent to you with Hopper;
- for Dexterity Share links: the first client download, and a reminder before the link closes.

They arrive as Direct messages from the **Hopper** integration. Connect finds people by their
Windows user name, so no email addresses are needed. When Connect is set up, Cliq is not used.

## Set up (once for the office)

1. In Dexterity Connect, open **your tile → Control room → Integrations**, type `Hopper` and
   click **Create token**.
2. Click **Copy settings**. You get a block like this:

   ```json
   { "connect": { "enabled": true, "hub": "192.168.1.20:47900", "fingerprint": "AB:CD:…", "token": "dxc_…" } }
   ```

3. Add the `connect` block to Hopper's office configuration, next to the existing `cliq` block.
   Every Hopper in the office picks it up.

To turn off only the Dexterity Share link notices, add `"linkNotices": false` inside `connect`.

## How it is secured

- Hopper talks to the hub over HTTPS and accepts **only** the certificate whose SHA-256
  fingerprint is configured, so another machine cannot pose as the hub.
- The token can only post messages as the Hopper integration. An admin can revoke it at any time
  in the Control room, and every change is in the audit log.
- The token never appears in Hopper's logs.
