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
      <ScrollViewStyleReset />
      <style dangerouslySetInnerHTML={{ __html: 'html,body{background-color:#010401;}' }} />
    </head>
    <body>{children}</body>
  </html>;
}
