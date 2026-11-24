/* Offline replacement for gmsoftsdk_v4.js.
   Provides the globals the Unity player reads, without any network requests,
   advertising SDKs, analytics or telemetry. */
(function () {
  'use strict';

  var gameId = (window.config && window.config.gameId) || 'escape-road-city';

  window.GMDEBUG = {};

  window.GMSOFT_OPTIONS = {
    enableAds: false,
    debug: false,
    gameId: gameId,
    pubId: '',
    unlockTimer: -1,
    timeShowInter: 60,
    timeShowReward: 60,
    sdkType: 'h5',
    hostindex: 1,
    allow_embed: 'yes',
    allow_host: 'yes'
  };

  // Same shape as the original /api/infov2 response, with every asset URL
  // rewritten to a file shipped next to the game.
  window.GMSOFT_MSG = {
    allow_embed: 'yes',
    allow_host: 'yes',
    enable_ads: 'no',
    debug_mode: 'no',
    pub_id: '',
    unlock_timer: -1,
    timeShowInter: 60,
    timeShowReward: 60,
    sdkType: 'h5',
    hostindex: 1,
    promotion: {
      enable: 'no',
      size: 200,
      call_to_action: 0,
      call_to_action2: 'no',
      promotion_list: []
    },
    game: {
      name: 'Escape Road City',
      description: 'Escape Road City is a thrilling car chase game on the streets!',
      image: 'images/escape-road-city-game.png',
      redirect_url: '',
      promotion: '',
      logo_url: 'images/azgames.png',
      moregames_url: ''
    }
  };

  // The player may be built with gdsdk / afg hooks; no-op callbacks keep
  // reward/pause flows from stalling while remaining completely offline.
  window.gdsdk = {
    AdType: { Rewarded: 'reward', Interstitial: 'interstitial' },
    preloadAd: function () { return Promise.resolve(true); },
    showAd: function () { return Promise.resolve(true); },
    sendEvent: function () { return Promise.resolve(true); }
  };

  // WeeGoo ad bridge.  With `preroll` undefined the Unity player falls back to
  // injecting afg.wgplayer.com scripts; a local loader object keeps that path
  // from ever being taken.
  window.wgAdsOffline = {
    log: function () {},
    ping: function () {},
    GameEvent: function () {},
    refetchAd: function () {},
    showAd: function () {},
    rewarded: {
      initSlot: function () {},
      show: function () {}
    }
  };
  window.preroll = {
    config: { loaderObjectName: 'wgAdsOffline' },
    log: window.wgAdsOffline.log,
    ping: window.wgAdsOffline.ping
  };
})();
