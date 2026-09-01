import { Container } from '@mantine/core';
import { useParams } from 'react-router';
import { AgentDetail } from '../components/AgentDetail';

export const AgentDetailPage = (): React.ReactElement => {
  const { agentId } = useParams();
  return (
    <Container size="xl" px={0}>
      <AgentDetail agentId={agentId ?? ''} />
    </Container>
  );
};
