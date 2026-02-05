import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
// Data disabled until @aws-amplify/data-construct supports custompipeline
// import { data } from './data/resource';
import { defineFrontend, definePipeline } from './custom/pipeline/resource';

const backend = defineBackend({
  auth,
  // data,
});

// Define frontend hosting (S3 + CloudFront)
const frontend = defineFrontend(backend.createStack('Frontend'));

// Define CI/CD pipeline without Amplify Hosting
definePipeline(backend.createStack('Pipeline'), {
  githubOwner: 'adrianjoshua-strutt',
  githubRepo: 'amplify-vite-react-custom-pipeline',
  githubBranch: 'main',
  githubTokenSecretName: 'github-token',
  stackName: 'amplify-vite-react-custom-pipeline',
  frontend,
});
