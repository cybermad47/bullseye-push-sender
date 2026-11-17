'use strict';
// BULLSEYE scheduled Web Push sender (free: GitHub Actions + Firebase Spark).
// Reads due jobs from /pushJobs (indexed by endAt), looks up the destination
// subscription under /users/{uid}/pushSubscriptions/{subId}, sends a standard
// Web Push with VAPID, then removes the job. No Firebase Blaze plan needed.
const admin = require('firebase-admin');
const webpush = require('web-push');

function getDb() {
    if (!admin.apps.length) {
        let serviceAccount;
        try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null'); }
        catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); }
        if (!serviceAccount) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing');
        const url = process.env.FIREBASE_DATABASE_URL ||
            `https://${serviceAccount.project_id}-default-rtdb.europe-west1.firebasedatabase.app`;
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: url });
    }
    return admin.database();
}

function configureWebPush() {
    const pub = process.env.VAPID_PUBLIC_KEY || '';
    const priv = process.env.VAPID_PRIVATE_KEY || '';
    if (!pub || !priv) throw new Error('VAPID public/private keys are missing');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
    return webpush;
}

// Exported separately so it can be unit-tested with fake db/webpush objects.
async function processJob(db, wp, jobId, job, now) {
    const jobRef = db.ref(`pushJobs/${jobId}`);
    try {
        if (!job.uid || !job.subscriptionId) { await jobRef.remove(); return 'dropped'; }
        const snap = await db.ref(`users/${job.uid}/pushSubscriptions/${job.subscriptionId}`).once('value');
        const sub = snap.val();
        if (!sub || !sub.endpoint || !sub.p256dh || !sub.auth) { await jobRef.remove(); return 'no-subscription'; }
        const payload = JSON.stringify({
            title: job.title || 'BULLSEYE',
            body: job.body || '',
            tag: job.tag || 'bullseye-timer',
            badge: './icons/badge-96.png',
            vibrate: [80, 40, 80]
        });
        await wp.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 3600, urgency: 'high' }
        );
        await jobRef.remove();
        return 'sent';
    } catch (err) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
            await db.ref(`users/${job.uid}/pushSubscriptions/${job.subscriptionId}`).remove().catch(() => {});
            await jobRef.remove().catch(() => {});
            return 'subscription-gone';
        }
        console.error('[BULLSEYE push] send failed', status, err && err.message);
        const attempts = Number(job.attempts || 0) + 1;
        if (attempts >= 3) await jobRef.remove().catch(() => {});
        else await jobRef.update({ endAt: (now || Date.now()) + 120000, attempts }).catch(() => {});
        return 'retry';
    }
}

async function run(deps = {}) {
    const db = deps.db || getDb();
    const wp = deps.webpush || configureWebPush();
    const now = deps.now || Date.now();
    const snap = await db.ref('pushJobs').orderByChild('endAt').endAt(now).once('value');
    if (!snap.exists()) return { scanned: 0, results: [] };
    const jobs = [];
    snap.forEach(child => jobs.push({ id: child.key, data: child.val() || {} }));
    const results = [];
    for (const job of jobs) {
        results.push({ id: job.id, result: await processJob(db, wp, job.id, job.data, now) });
    }
    return { scanned: jobs.length, results };
}

if (require.main === module) {
    run().then(out => {
        console.log('[BULLSEYE push] scan complete:', JSON.stringify(out));
    }).catch(err => {
        console.error('[BULLSEYE push] FAILED', err);
        process.exitCode = 1;
    });
}

module.exports = { run, processJob, getDb, configureWebPush };
