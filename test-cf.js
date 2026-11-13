import { createStack } from './src/app/api/cloudformation/storage.js';

(async () => {
  try {
    const id = await createStack(
      '123456789012',
      'test-stack',
      '{"AWSTemplateFormatVersion":"2010-09-09","Resources":{"P":{"Type":"AWS::SSM::Parameter","Properties":{"Type":"String","Value":"test"}}}}'
    );
    console.log('Created stack:', id);
  } catch (e) {
    console.error('Error:', e);
  }
})();
