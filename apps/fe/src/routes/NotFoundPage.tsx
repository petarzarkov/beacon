import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { useNavigate } from 'react-router';

export const NotFoundPage = (): React.ReactElement => {
  const navigate = useNavigate();
  return (
    <Center mih="60vh">
      <Stack align="center" gap="sm">
        <Title order={2}>Not found</Title>
        <Text c="dimmed">That page is not part of the console.</Text>
        <Button variant="light" onClick={() => navigate('/agents')}>
          Back to the fleet
        </Button>
      </Stack>
    </Center>
  );
};
