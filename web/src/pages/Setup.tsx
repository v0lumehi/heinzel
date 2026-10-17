import { Accordion, Alert, Anchor, Badge, Button, Code, CopyButton, Group, List, Paper, Stack, Text, ThemeIcon, Timeline } from "@mantine/core";
import { IconAlertTriangle, IconBrandSlack, IconBrandTeams, IconCheck, IconDownload, IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type SetupResponse } from "../api";
import { Loaded, PageHeader, SectionTitle } from "../components";
import { fmtDate } from "../format";

export function SetupPage() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api<SetupResponse>("/api/setup"), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader title="Setup" />
      <Loaded query={setup}>
        {(s) => (
          <>
            <Checklist checks={s.checks} />
            <SectionTitle>Chat platforms</SectionTitle>
            <Text size="sm" c="dimmed" mb="sm" maw={760}>
              Credentials are deployment configuration: put them into the environment (Helm Secret, .env) and restart. This page shows the steps
              and whether the connection works.
            </Text>
            <Accordion variant="separated" multiple defaultValue={s.platforms.filter((p) => !p.lastMessageAt).map((p) => p.platform)}>
              <Accordion.Item value="slack">
                <Accordion.Control icon={<IconBrandSlack size={20} />}>
                  <PlatformTitle name="Slack" p={s.platforms.find((p) => p.platform === "slack")!} />
                </Accordion.Control>
                <Accordion.Panel>
                  <SlackSteps botName={s.botName} />
                </Accordion.Panel>
              </Accordion.Item>
              <Accordion.Item value="teams">
                <Accordion.Control icon={<IconBrandTeams size={20} />}>
                  <PlatformTitle name="Microsoft Teams" p={s.platforms.find((p) => p.platform === "teams")!} />
                </Accordion.Control>
                <Accordion.Panel>
                  <TeamsSteps setup={s} />
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </>
        )}
      </Loaded>
    </>
  );
}

function Checklist({ checks }: { checks: SetupResponse["checks"] }) {
  const open = checks.filter((c) => !c.ok);
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Readiness</Text>
        <Badge color={open.some((c) => c.level === "required") ? "red" : open.length ? "yellow" : "green"} variant="light">
          {checks.length - open.length} of {checks.length} done
        </Badge>
      </Group>
      <Stack gap="xs">
        {checks.map((c) => (
          <Group key={c.id} gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon size="sm" radius="xl" color={c.ok ? "green" : c.level === "required" ? "red" : "yellow"} variant="light" mt={2}>
              {c.ok ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
            </ThemeIcon>
            <div>
              <Text size="sm" fw={500}>
                {c.title}
                {!c.ok && c.level === "recommended" && <Text span size="xs" c="dimmed"> · recommended</Text>}
              </Text>
              {!c.ok && <Text size="xs" c="dimmed">{c.hint}</Text>}
            </div>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

function PlatformTitle({ name, p }: { name: string; p: SetupResponse["platforms"][number] }) {
  const badge = !p.configured
    ? { label: "not configured", color: "gray" }
    : !p.connected
      ? { label: "not connected", color: "red" }
      : p.lastMessageAt
        ? { label: "working", color: "green" }
        : { label: "connected, no messages yet", color: "yellow" };
  return (
    <Group gap="sm" wrap="wrap">
      <Text fw={500}>{name}</Text>
      <Badge variant="light" color={badge.color}>{badge.label}</Badge>
      {p.detail && <Text size="xs" c="dimmed">{p.detail}</Text>}
      {p.lastMessageAt && <Text size="xs" c="dimmed">last message {fmtDate(p.lastMessageAt)}</Text>}
    </Group>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Timeline.Item title={title}>
      <Stack gap={6} mt={4}>{children}</Stack>
    </Timeline.Item>
  );
}

function Env({ name, what }: { name: string; what: string }) {
  return (
    <Text size="sm">
      <Code>{name}</Code> = {what}
    </Text>
  );
}

function SlackSteps({ botName }: { botName: string }) {
  const handle = botName.replace(/\s+/g, "");
  return (
    <Timeline bulletSize={22} lineWidth={2} active={-1}>
      <Step title="Create the Slack app from the manifest">
        <Text size="sm">
          On <Anchor href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</Anchor>: <i>Create New App</i> →{" "}
          <i>From a manifest</i> → pick the workspace → paste the manifest.
        </Text>
        <Group>
          <Button component="a" href="/api/setup/slack-manifest.yaml" size="xs" variant="light" leftSection={<IconDownload size={14} />}>
            Download manifest for “{botName}”
          </Button>
        </Group>
      </Step>
      <Step title="Create the app-level token">
        <Text size="sm"><i>Basic Information</i> → <i>App-Level Tokens</i> → <i>Generate</i> with the scope <Code>connections:write</Code>.</Text>
        <Env name="SLACK_APP_TOKEN" what="the token (xapp-…)" />
      </Step>
      <Step title="Install the app">
        <Text size="sm"><i>Install App</i> → <i>Install to Workspace</i>, then copy the <i>Bot User OAuth Token</i>.</Text>
        <Env name="SLACK_BOT_TOKEN" what="the token (xoxb-…)" />
      </Step>
      <Step title="Set both tokens in the deployment and restart">
        <Text size="sm">Slack connects outwards (Socket Mode): no public URL or firewall change needed.</Text>
      </Step>
      <Step title="Try it">
        <Text size="sm">
          In a channel: <Code>/invite @{handle}</Code>, then <Code>@{handle} !help</Code>. The status above turns green with the first message.
        </Text>
      </Step>
    </Timeline>
  );
}

function TeamsSteps({ setup }: { setup: SetupResponse }) {
  const t = setup.teams;
  const endpoint = `https://<public host>/api/messages`;
  return (
    <Stack>
      {t.playground && (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
          TEAMS_PLAYGROUND is on: Teams runs in local test mode without authentication. Remove it before connecting a real tenant.
        </Alert>
      )}
      <Timeline bulletSize={22} lineWidth={2} active={-1}>
        <Step title="Make the messaging endpoint reachable over HTTPS">
          <Text size="sm">
            Microsoft sends messages to <Code>/api/messages</Code> on port <Code>{t.port}</Code>. In production use the Helm ingress for Teams; for
            a test from a laptop a dev tunnel (<Code>devtunnel host -p {t.port} --allow-anonymous</Code>).
          </Text>
        </Step>
        <Step title="Register the bot">
          <Text size="sm">
            Teams Developer Portal (<Anchor href="https://dev.teams.microsoft.com/bots" target="_blank" rel="noreferrer">dev.teams.microsoft.com</Anchor>)
            → <i>Tools</i> → <i>Bot management</i> → <i>New bot</i>, or an <i>Azure Bot</i> resource (single tenant). Endpoint address:
          </Text>
          <Group gap="xs">
            <Code>{endpoint}</Code>
            <CopyButton value={endpoint}>{({ copied, copy }) => <Button size="compact-xs" variant="subtle" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>}</CopyButton>
          </Group>
          <Text size="sm">Add a client secret, then set:</Text>
          <List size="sm" spacing={2}>
            <List.Item><Env name="TEAMS_APP_ID" what={t.appId ? `${t.appId} ✓` : "the bot id / Microsoft App ID"} /></List.Item>
            <List.Item><Env name="TEAMS_APP_PASSWORD" what="the client secret (in the Secret)" /></List.Item>
            <List.Item><Env name="TEAMS_TENANT_ID" what={t.tenantId ? `${t.tenantId} ✓` : "your directory (tenant) id"} /></List.Item>
          </List>
        </Step>
        <Step title="Allow custom apps in your tenant">
          <Text size="sm">
            Teams admin center → <i>Teams apps</i> → <i>Setup policies</i>: <i>Upload custom apps</i> on; <i>Manage apps</i> → <i>Org-wide app
            settings</i>: allow custom apps. Or publish the package to your org's app catalog instead.
          </Text>
        </Step>
        <Step title="Upload the app package">
          <Text size="sm">
            Contains the bot id and the permissions to read channel messages without an @-mention (ambient mode). In Teams: <i>Apps</i> →{" "}
            <i>Manage your apps</i> → <i>Upload an app</i> → <i>Upload a custom app</i>, then <i>Add to a team</i>.
          </Text>
          <Group>
            <Button component="a" href="/api/setup/teams-app.zip" size="xs" variant="light" leftSection={<IconDownload size={14} />} disabled={!t.packageAvailable}>
              Download app package
            </Button>
            {!t.packageAvailable && <Text size="xs" c="dimmed">available once TEAMS_APP_ID is set</Text>}
          </Group>
        </Step>
        <Step title="Try it">
          <Text size="sm">Write to the bot directly, or <Code>@{setup.botName} !help</Code> in a channel of the team.</Text>
        </Step>
      </Timeline>
    </Stack>
  );
}
