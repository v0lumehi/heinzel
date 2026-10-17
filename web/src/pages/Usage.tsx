import { Badge, Paper, SegmentedControl, SimpleGrid, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type UsageResponse } from "../api";
import { EmptyRow, Loaded, PageHeader, SectionTitle } from "../components";
import { fmtNumber } from "../format";

export function UsagePage() {
  const [days, setDays] = useState("7");
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api<UsageResponse>(`/api/usage?days=${days}`) });
  return (
    <>
      <PageHeader title="Usage">
        <SegmentedControl
          value={days}
          onChange={setDays}
          data={[
            { value: "1", label: "24 hours" },
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </PageHeader>
      <Loaded query={usage}>
        {(u) => {
          const total = u.byChannel.reduce(
            (t, r) => ({ calls: t.calls + r.calls, p: t.p + r.promptTokens, c: t.c + r.completionTokens }),
            { calls: 0, p: 0, c: 0 },
          );
          return (
            <>
              <SimpleGrid cols={{ base: 1, xs: 3 }} mb="md">
                <Stat label="LLM calls" value={total.calls} />
                <Stat label="Input tokens" value={total.p} />
                <Stat label="Output tokens" value={total.c} />
              </SimpleGrid>
              <Text size="sm" c="dimmed">
                Costs depend on the models' prices; your LLM gateway (e.g. Requesty) shows them per channel via the request metadata.
              </Text>
              <SectionTitle>By channel</SectionTitle>
              <Paper withBorder>
                <Table.ScrollContainer minWidth={560}>
                  <Table verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Channel</Table.Th>
                        <Table.Th ta="right">Calls</Table.Th>
                        <Table.Th ta="right">Input tokens</Table.Th>
                        <Table.Th ta="right">Output tokens</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {u.byChannel.length === 0 && <EmptyRow cols={4} text="No LLM calls in this period." />}
                      {u.byChannel.map((r) => (
                        <Table.Tr key={r.channelKey ?? "none"}>
                          <Table.Td>
                            {r.channelKey ? <Link to={`/channels/${encodeURIComponent(r.channelKey)}`}>{r.name ?? r.channelKey}</Link> : <Text c="dimmed">no channel</Text>}
                          </Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.calls)}</Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.promptTokens)}</Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.completionTokens)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Paper>
              <SectionTitle>By day and model</SectionTitle>
              <Paper withBorder>
                <Table.ScrollContainer minWidth={700}>
                  <Table verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Day</Table.Th>
                        <Table.Th>Model</Table.Th>
                        <Table.Th>Purpose</Table.Th>
                        <Table.Th ta="right">Calls</Table.Th>
                        <Table.Th ta="right">Input tokens</Table.Th>
                        <Table.Th ta="right">Output tokens</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {u.byDay.length === 0 && <EmptyRow cols={6} text="No LLM calls in this period." />}
                      {u.byDay.map((r) => (
                        <Table.Tr key={`${r.day}-${r.model}-${r.purpose}`}>
                          <Table.Td>{r.day}</Table.Td>
                          <Table.Td><Text size="sm" ff="monospace">{r.model}</Text></Table.Td>
                          <Table.Td><Badge variant="light" color="gray">{r.purpose}</Badge></Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.calls)}</Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.promptTokens)}</Table.Td>
                          <Table.Td ta="right">{fmtNumber(r.completionTokens)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Paper>
            </>
          );
        }}
      </Loaded>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Text size="xl" fw={700}>{fmtNumber(value)}</Text>
    </Paper>
  );
}
