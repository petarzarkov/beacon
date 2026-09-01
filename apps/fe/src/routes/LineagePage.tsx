import { Container, Paper, Stack, Text, Title } from '@mantine/core';
import { LineageTree } from '../components/LineageTree';

export const LineagePage = (): React.ReactElement => (
  <Container size="xl" px={0}>
    <Stack gap="md">
      <div>
        <Title order={3}>Lineage</Title>
        <Text c="dimmed" size="sm">
          Who installed whom. Seed agents at the root; deployed and propagated
          hosts nested under the agent that reached them.
        </Text>
      </div>
      <Paper withBorder radius="md" p="md">
        <LineageTree />
      </Paper>
    </Stack>
  </Container>
);
