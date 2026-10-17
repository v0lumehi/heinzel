# Microsoft Teams

Status: the adapter (`src/adapters/teams/`) works against the Microsoft 365 Agents Playground (personal chat: answers, commands, message updates). It has not been run in a real Teams tenant yet.

Teams differs from Slack in one important way: Teams **pushes** activities to an HTTPS endpoint of ours (`POST /api/messages`, port `TEAMS_PORT`, default 3978). There is no Socket Mode, so a real tenant needs a publicly reachable URL (reverse proxy or dev tunnel).

## Local testing with the Agents Playground

The Playground emulates Teams in the browser. You need no Azure account, no tenant and no tunnel.

```bash
# .env
TEAMS_PLAYGROUND=true        # no credentials, unauthenticated requests, listens on 127.0.0.1 only

pnpm dev                     # Slack can stay configured; both adapters run side by side
npx @microsoft/m365agentsplayground -e http://localhost:3978/api/messages -c msteams
```

The Playground opens at http://localhost:56150. Write to Heinzel like in a DM: `!help`, `!status`, questions.

Never set `TEAMS_PLAYGROUND=true` in production: the endpoint then accepts requests without checking that they come from Microsoft.

Limits of the Playground:
- No 👀 reaction (the Playground answers 404; Heinzel ignores it).
- No Graph, no RSC permissions, no app manifest. Ambient mode in channels can only be tested in a real tenant.

For scripted tests there is the headless client `@microsoft/m365agentsplayground-cli` (`TestClient.sendMessage()`).

## Real tenant (next step)

1. **Tenant:** one where you are admin and custom apps may be uploaded (Teams admin center → *Teams apps* → *Setup policies* / *Org-wide app settings*). A Microsoft 365 Business Basic trial works.
2. **Azure Bot:** in the Azure portal create an *Azure Bot* resource (type *Single Tenant*, plan F0). It creates an app registration; add a client secret.
   - `TEAMS_APP_ID` = Microsoft App ID, `TEAMS_APP_PASSWORD` = client secret, `TEAMS_TENANT_ID` = directory (tenant) id.
   - *Channels* → add *Microsoft Teams*.
   - *Configuration* → messaging endpoint `https://<public host>/api/messages`.
3. **Public URL for local development:** `devtunnel host -p 3978 --allow-anonymous` (Microsoft Dev Tunnels) or `ngrok http 3978`. Anonymous tunnel access is fine: every request carries a JWT that the SDK validates.
4. **App package:** `manifest.json` plus two icons, zipped, uploaded in Teams (*Apps* → *Manage your apps* → *Upload an app*). Not in the repository yet. It needs:
   - `bots[].botId` = `TEAMS_APP_ID`, scopes `personal`, `team`, `groupChat`.
   - RSC permissions `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` (`authorization.permissions.resourceSpecific`), so Heinzel receives channel and group chat messages without an @-mention (ambient mode).

## How Teams maps to Heinzel

| Teams | Heinzel |
|---|---|
| Conversation id (`19:…@thread.tacv2`) | `channelId` (channel key `teams:<id>`) |
| Channel thread: conversation id `…;messageid=<root>` | `threadId` = root message id |
| New channel post | its own thread root |
| Personal chat | `isDirect`, no threads |
| Group chat | no threads: every message is its own root |
| `<at>Name</at>` + mention entity for the bot | `@Name` in the text, `mentionsBot` |

- **Sending:** through the Bot Connector REST API with `textFormat: markdown`. Headings become bold, single line breaks become hard breaks.
- **Proactive posts** (ambient, follow-ups, coding status): the service URL of each conversation is learned from incoming activities and kept in memory. After a restart Heinzel uses `TEAMS_SERVICE_URL` (default: the global `https://smba.trafficmanager.net/teams`).
- **History:** the adapter has no `fetchThread`/`fetchRecent` yet (that needs Microsoft Graph). The engine uses its stored copy of the conversation, which covers everything since Heinzel was added.
- **Acknowledgement:** 👀 reaction through the Bot Connector reactions API (to be verified in a real tenant).

## Open points

- Verify in a real tenant: auth, threads in channels, RSC / ambient mode, reactions, markdown rendering, proactive posts after a restart.
- App manifest template in the repository.
- History through Microsoft Graph (`fetchThread` / `fetchRecent`) for messages from before Heinzel joined.
- Real @-mentions in replies (`<at>` plus mention entity); today `@Name` stays plain text.
- Store the service URL per channel (`platform_refs` on `channels`) if the global fallback turns out to be unreliable.
