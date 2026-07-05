import { messageSchema, reduceTextContent, textContent } from '@smolpaws/openhands-agent';

import { explainSkippedExample, getExampleLlmClient } from './_shared/exampleProfile.js';

const llm = await getExampleLlmClient();
if (llm === null) {
  explainSkippedExample('hello-world');
} else {
  const response = await llm.complete([
    messageSchema.parse({
      role: 'user',
      content: [textContent('Reply with exactly: Hello from the TypeScript OpenHands agent.')],
    }),
  ]);

  console.log(reduceTextContent(response.message));
}
