/** The Slack app manifest (slack-app-manifest.yaml) for a given bot name, for the setup guide in the admin UI. */
export function slackManifest(botName: string): string {
  const name = botName.replace(/["\\\n]/g, "").slice(0, 35) || "Heinzel";
  return `# Create the Slack app from this manifest: https://api.slack.com/apps → "Create New App" → "From a manifest".
display_information:
  name: ${name}
  description: Open-source AI teammate. Tag @${name.replace(/\s+/g, "")} or let it follow a channel.
  background_color: "#2c2d30"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${name}
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - chat:write
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
}
