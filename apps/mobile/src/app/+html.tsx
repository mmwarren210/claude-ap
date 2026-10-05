import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// The web page shell: the home-screen icon and name for "Add to Home Screen" (iPhone and Android), and a dark start.
export default function Root({ children }: PropsWithChildren) {
  return <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
      <title>CrownIQ</title>
      <meta name="theme-color" content="#010401" />
      <meta name="apple-mobile-web-app-title" content="CrownIQ" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.webmanifest" />
      {/* The preview a text or social app shows for the link. */}
      <meta name="description" content="CrownIQ · Sports Intelligence, powered by GKR. Beta." />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="CrownIQ" />
      <meta property="og:title" content="CrownIQ · Beta" />
      <meta property="og:description" content="Sports Intelligence · Powered by GKR" />
      <meta property="og:url" content="https://crowniq.up.railway.app/" />
      <meta property="og:image" content="https://crowniq.up.railway.app/og.png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="https://crowniq.up.railway.app/og.png" />
      <ScrollViewStyleReset />
      <style dangerouslySetInnerHTML={{ __html: 'html,body{background-color:#010401;}' }} />
    </head>
    <body>{children}</body>
  </html>;
}
