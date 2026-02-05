import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <main>
          <h1>Hello {user?.signInDetails?.loginId}</h1>
          <button onClick={signOut}>Sign out</button>
          <div>
            🥳 App successfully hosted with custom pipeline deployment!
            <br />
            <p>Auth is working. Data is disabled until amplify-category-api supports custompipeline.</p>
          </div>
        </main>
      )}
    </Authenticator>
  );
}

export default App;
