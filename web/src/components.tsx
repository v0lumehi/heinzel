import { Alert, Center, Group, Loader, Table, Text, Title } from "@mantine/core";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Group justify="space-between" mb="lg" wrap="wrap">
      <Title order={2}>{title}</Title>
      {children}
    </Group>
  );
}

/** Renders loading and error states of a query, and the content once data is there. */
export function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <Center py="xl"><Loader /></Center>;
  if (query.isError) return <Alert color="red" title="Could not load">{query.error.message}</Alert>;
  return <>{children(query.data)}</>;
}

export function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <Table.Tr>
      <Table.Td colSpan={cols}>
        <Text c="dimmed" ta="center" py="md">{text}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Title order={4} mt="xl" mb="sm">{children}</Title>;
}
