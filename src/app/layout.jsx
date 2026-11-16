import React from 'react';

export const metadata = {
  title: 'OrderBlock — 5-Stage Visual Funnel',
  description: 'Real-time 218 NSE F&O OrderBlock & Institutional Flow Terminal',
};

const THEME_INIT_SCRIPT = `(function(){try{var m=/(?:^|;\\s*)ob_theme=(light|dark)(?:;|$)/.exec(document.cookie);var ov=m?m[1]:null;var mqL=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)');var mqD=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');var sys=(mqL&&mqL.matches)?'light':(mqD&&mqD.matches)?'dark':'dark';var t=ov||sys;var r=document.documentElement;r.setAttribute('data-theme',t);r.style.colorScheme=t;var mc=document.querySelector('meta[name="color-scheme"]');if(mc)mc.content=ov||'light dark';}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
