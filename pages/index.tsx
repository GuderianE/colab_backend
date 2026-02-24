import Head from 'next/head';

export default function Home() {
  return (
    <>
      <Head>
        <title>Colab Backend Service</title>
      </Head>
      <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem', lineHeight: 1.5 }}>
        <h1>Colab Backend Service</h1>
        <p>This service is backend-only. Collaboration UI is hosted in Scriptum/Platform.</p>
        <ul>
          <li>
            WebSocket: <code>/ws</code>
          </li>
          <li>
            Health: <code>/health</code>
          </li>
          <li>
            Workspace info: <code>/workspace/:id</code>
          </li>
        </ul>
      </main>
    </>
  );
}
