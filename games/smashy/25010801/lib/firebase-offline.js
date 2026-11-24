/*
 * Offline Firebase compatibility layer.
 *
 * The Unity player contains a Firebase plugin.  Its JavaScript bridge calls
 * the global `firebase` object directly (analytics, auth, firestore, realtime
 * database and storage).  The original page loaded the real Firebase SDK from
 * a CDN; this file provides the same surface with harmless no-ops so gameplay
 * never touches the network and never throws "firebase is not defined".
 */
(function (global) {
    'use strict';

    function noop() {}
    function resolved(value) { return Promise.resolve(value); }

    function snapshot(value) {
        return {
            val: function () { return value === undefined ? null : value; },
            exists: value !== undefined && value !== null,
            data: function () { return value === undefined ? null : value; },
            id: 'offline',
            key: 'offline'
        };
    }

    function querySnapshot() {
        return {
            docs: [],
            size: 0,
            empty: true,
            forEach: noop
        };
    }

    var user = {
        uid: 'offline-user',
        email: 'offline@localhost',
        displayName: 'Player',
        isAnonymous: true,
        emailVerified: true,
        metadata: {},
        providerData: [],
        delete: function () { return resolved(); },
        getIdToken: function () { return resolved('offline-token'); },
        reload: function () { return resolved(); },
        sendEmailVerification: function () { return resolved(); },
        toJSON: function () { return { uid: user.uid, email: user.email }; }
    };

    /* ------------------------------- analytics ------------------------------ */
    function analytics() {
        return {
            logEvent: noop,
            setAnalyticsCollectionEnabled: noop,
            setCurrentScreen: noop,
            setSessionId: noop,
            setUserId: noop,
            setUserProperties: noop,
            resetAnalyticsData: function () { return resolved(); }
        };
    }

    /* --------------------------------- auth --------------------------------- */
    function makeAuthProvider(providerId) {
        return {
            providerId: providerId,
            addScope: function () { return this; },
            setCustomParameters: function () { return this; }
        };
    }
    function auth() {
        return {
            currentUser: user,
            app: null,
            applyActionCode: function () { return resolved(); },
            checkActionCode: function () { return resolved({}); },
            confirmPasswordReset: function () { return resolved(); },
            createUserWithEmailAndPassword: function () { return resolved({ user: user }); },
            fetchProvidersForEmail: function () { return resolved([]); },
            getRedirectResult: function () { return resolved({ user: user }); },
            onAuthStateChanged: function (cb) { if (typeof cb === 'function') setTimeout(function () { cb(user); }, 0); return noop; },
            onIdTokenChanged: function (cb) { if (typeof cb === 'function') setTimeout(function () { cb(user); }, 0); return noop; },
            sendPasswordResetEmail: function () { return resolved(); },
            setPersistence: function () { return resolved(); },
            signInAnonymously: function () { return resolved({ user: user }); },
            signInWithCredential: function () { return resolved({ user: user }); },
            signInWithCustomToken: function () { return resolved({ user: user }); },
            signInWithEmailAndPassword: function () { return resolved({ user: user }); },
            signInWithPopup: function () { return resolved({ user: user }); },
            signInWithRedirect: function () { return resolved({ user: user }); },
            signOut: function () { return resolved(); },
            updateCurrentUser: function () { return resolved(); },
            verifyPasswordResetCode: function () { return resolved(user.email); }
        };
    }
    auth.GoogleAuthProvider = function () { return makeAuthProvider('google.com'); };
    auth.FacebookAuthProvider = function () { return makeAuthProvider('facebook.com'); };
    auth.EmailAuthProvider = function () { return makeAuthProvider('password'); };
    auth.GithubAuthProvider = function () { return makeAuthProvider('github.com'); };
    auth.TwitterAuthProvider = function () { return makeAuthProvider('twitter.com'); };
    auth.PhoneAuthProvider = function () { return makeAuthProvider('phone'); };
    auth.OAuthProvider = function (id) { return makeAuthProvider(id); };
    auth.Auth = auth;
    auth.User = function () { return user; };

    /* ------------------------------- firestore ------------------------------ */
    function fieldValue(type, value) {
        return { __offlineFieldValue: type, value: value };
    }
    firestore.FieldValue = {
        increment: function (n) { return fieldValue('increment', n); },
        arrayUnion: function (v) { return fieldValue('arrayUnion', v); },
        arrayRemove: function (v) { return fieldValue('arrayRemove', v); },
        delete: function () { return fieldValue('delete'); },
        serverTimestamp: function () { return fieldValue('serverTimestamp'); }
    };
    firestore.Timestamp = function (seconds, nanoseconds) {
        this.seconds = seconds || 0;
        this.nanoseconds = nanoseconds || 0;
        this.toDate = function () { return new Date(this.seconds * 1000); };
    };
    firestore.GeoPoint = function (lat, lng) { this.latitude = lat; this.longitude = lng; };
    firestore.DocumentReference = function () {};
    firestore.CollectionReference = function () {};

    function docRef(id) {
        return {
            id: id || 'offline',
            path: id || 'offline',
            get: function () { return resolved(snapshot(null)); },
            set: function () { return resolved(); },
            update: function () { return resolved(); },
            delete: function () { return resolved(); },
            onSnapshot: function (a, b) {
                var cb = typeof a === 'function' ? a : b;
                if (typeof cb === 'function') setTimeout(function () { cb(snapshot(null)); }, 0);
                return noop;
            },
            collection: function (name) { return collectionRef(name); }
        };
    }

    function collectionRef(name) {
        return {
            id: name,
            path: name,
            doc: function (id) { return docRef(id); },
            add: function () { return resolved({ id: 'offline' }); },
            get: function () { return resolved(querySnapshot()); },
            onSnapshot: function (a, b) {
                var cb = typeof a === 'function' ? a : b;
                if (typeof cb === 'function') setTimeout(function () { cb(querySnapshot()); }, 0);
                return noop;
            },
            where: function () { return this; },
            orderBy: function () { return this; },
            limit: function () { return this; },
            startAt: function () { return this; },
            startAfter: function () { return this; },
            endAt: function () { return this; },
            endBefore: function () { return this; }
        };
    }

    function firestore() {
        return {
            app: null,
            collection: collectionRef,
            doc: docRef,
            collectionGroup: collectionRef,
            batch: function () {
                return {
                    set: function () { return this; },
                    update: function () { return this; },
                    delete: function () { return this; },
                    commit: function () { return resolved([]); }
                };
            },
            runTransaction: function (fn) {
                if (typeof fn === 'function') return resolved(fn({ get: function () { return resolved(snapshot(null)); } }));
                return resolved();
            },
            settings: noop,
            enableNetwork: function () { return resolved(); },
            disableNetwork: function () { return resolved(); },
            terminate: function () { return resolved(); },
            waitForPendingWrites: function () { return resolved(); },
            clearPersistence: function () { return resolved(); }
        };
    }

    /* --------------------------- realtime database -------------------------- */
    function dataRef(path) {
        var ref = {
            key: String(path || '').split('/').pop() || 'offline',
            path: String(path || ''),
            child: function (childPath) { return dataRef(String(path || '') + '/' + childPath); },
            parent: function () { return dataRef(String(path || '').split('/').slice(0, -1).join('/')); },
            root: function () { return dataRef(''); },
            set: function () { return resolved(); },
            update: function () { return resolved(); },
            remove: function () { return resolved(); },
            push: function () { return dataRef(String(path || '') + '/offline'); },
            once: function () { return resolved(snapshot(null)); },
            on: function (event, cb) {
                if (typeof cb === 'function') setTimeout(function () { cb(snapshot(null)); }, 0);
                return cb;
            },
            off: noop,
            transaction: function (fn) {
                var next = typeof fn === 'function' ? fn(null) : null;
                return resolved({ committed: true, snapshot: snapshot(next) });
            },
            setWithPriority: function () { return resolved(); },
            setPriority: function () { return resolved(); },
            toJSON: function () { return String(path || ''); }
        };
        return ref;
    }
    function database() {
        return {
            app: null,
            ref: dataRef,
            refFromURL: dataRef,
            goOffline: noop,
            goOnline: noop,
            terminate: function () { return resolved(); }
        };
    }
    database.ServerValue = {
        TIMESTAMP: { '.sv': 'timestamp' },
        increment: function (n) { return { '.sv': { increment: n } }; }
    };

    /* -------------------------------- storage ------------------------------- */
    function storageRef(path) {
        return {
            key: String(path || '').split('/').pop() || 'offline',
            fullPath: String(path || ''),
            bucket: 'offline',
            child: function (childPath) { return storageRef(String(path || '') + '/' + childPath); },
            parent: function () { return storageRef(String(path || '').split('/').slice(0, -1).join('/')); },
            root: function () { return storageRef(''); },
            put: function () { return resolved({ bytesTransferred: 0, totalBytes: 0, state: 'success' }); },
            putString: function () { return resolved({ bytesTransferred: 0, totalBytes: 0, state: 'success' }); },
            getDownloadURL: function () { return resolved(location.origin + '/25010801/offline/stub.json'); },
            getMetadata: function () { return resolved({ name: 'offline', fullPath: String(path || '') }); },
            updateMetadata: function () { return resolved({}); },
            delete: function () { return resolved(); },
            listAll: function () { return resolved({ items: [], prefixes: [] }); },
            list: function () { return resolved({ items: [], prefixes: [] }); }
        };
    }
    function storage() {
        return {
            app: null,
            ref: storageRef,
            refFromURL: storageRef,
            terminate: function () { return resolved(); }
        };
    }

    /* --------------------------------- core --------------------------------- */
    var app = {
        name: '[DEFAULT]',
        options: global.firebaseConfig || {},
        analytics: analytics,
        auth: auth,
        database: database,
        firestore: firestore,
        storage: storage,
        delete: function () { return resolved(); }
    };

    var firebase = {
        SDK_VERSION: 'offline',
        apps: [app],
        app: app,
        initializeApp: function () { return app; },
        analytics: analytics,
        auth: auth,
        database: database,
        firestore: firestore,
        storage: storage,
        messaging: function () {
            return {
                getToken: function () { return resolved('offline-token'); },
                onMessage: noop,
                onBackgroundMessage: noop,
                requestPermission: function () { return resolved(); },
                useServiceWorker: noop,
                setBackgroundMessageHandler: noop
            };
        },
        functions: function () {
            return {
                httpsCallable: function () {
                    return function () { return resolved({ data: {} }); };
                }
            };
        },
        remoteConfig: function () {
            return {
                activate: function () { return resolved(true); },
                fetch: function () { return resolved(); },
                fetchAndActivate: function () { return resolved(true); },
                getValue: function () { return { asString: function () { return ''; }, asNumber: function () { return 0; } }; },
                setDefaults: function () { return resolved(); }
            };
        },
        performance: function () {
            return { trace: function () { return { start: noop, stop: noop, putAttribute: noop, putMetric: noop }; } };
        },
        installations: function () {
            return { get: function () { return resolved({ id: 'offline', authToken: 'offline-token' }); } };
        }
    };

    global.firebase = firebase;
    if (global.window) global.window.firebase = firebase;
})(typeof window !== 'undefined' ? window : this);
