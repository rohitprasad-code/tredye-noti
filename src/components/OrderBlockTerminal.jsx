'use client';

import React from 'react';
import Script from 'next/script';
import NavRail from './NavRail';
import OrderBlockTopBar from './OrderBlockTopBar';

export default function OrderBlockTerminal() {
  return (
    <>
      <link rel="stylesheet" href="/vendor/fonts.css" />
      <link rel="stylesheet" href="/static/ob/orderblock.css" />
      <link rel="stylesheet" href="/static/ob/orderblock-light.css" id="obf-light" />
      <Script src="/vendor/gsap.min.js" strategy="afterInteractive" />
      <Script src="/market-hours.js" strategy="afterInteractive" />
      <Script src="/static/ob/orderblock.js" strategy="afterInteractive" />

      <NavRail active="orderblock" />
      <OrderBlockTopBar />

      <div id="atmo" aria-hidden="true" />
      <div id="stage" aria-label="OBF order-block flow dashboard">
        <div className="L" id="lyBase" />
        <div className="L" id="lyLight" />
        <div className="L" id="lyHalves" />
        <div className="L" id="lyVig" />
        <div id="topRail" />
        <div id="crest" />
        <div id="plumeWrap" />
        <div id="chips" />
        <div id="idxTags" />
        <div id="ladderWrap" />
        <div id="nodes" />
        <div id="tiles" />
        <div id="bridges" />
        <div id="tickets" />
        <div id="fxWrap" />
        <div id="inspector" role="status" />
      </div>
      <div id="stack" />
      <div className="ob-toast-region" role="region" aria-label="Notifications">
        <div id="obActionToast" className="ob-toast" popover="manual">
          <span className="ob-toast-ico" aria-hidden="true">✓</span>
          <span className="ob-toast-body">
            <span className="ob-toast-msg" />
            <span className="ob-toast-sub" />
          </span>
          <button
            type="button"
            className="ob-toast-close"
            popoverTarget="obActionToast"
            popoverTargetAction="hide"
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
        <div id="obActionAnnounce" className="ob-sr" role="status" aria-live="polite" aria-atomic="true" />
      </div>
    </>
  );
}
