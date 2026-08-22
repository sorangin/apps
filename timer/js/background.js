const Background = {
    wakeLock: null,
    video: null,

    hasRequestedPermission: false,
    async init() {
        // Create hidden video for persistence
        if (!this.video) {
            this.video = document.createElement('video');
            this.video.id = 'persistence-video';
            this.video.muted = true;
            this.video.playsInline = true;
            this.video.loop = true;
            // Tiny silent video base64
            this.video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21hc2YxbXA0MgAAAAhmcmVlAAAAAG1kYXQAAAAIZnJlZQAAAAt0cmFrAAACAGlzb21hc2YxbXA0MgAAAAhmcmVlAAAACGZyZWUAAAALdHJhawAAAgBpc29tYXNmMW1wNDIAAAAIZnJlZQAAAARtZWFk';
            document.body.appendChild(this.video);
        }

        if ('wakeLock' in navigator) {
            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible') {
                    if ((typeof Timer !== 'undefined' && Timer.isRunning) || (typeof Stopwatch !== 'undefined' && Stopwatch.running)) {
                        this.wakeLock = null;
                        await this.startPersistence();
                    }
                }
            });
        }
    },

    async requestNotificationPermission() {
        if (!this.hasRequestedPermission && 'Notification' in window && Notification.permission === 'default') {
            this.hasRequestedPermission = true;
            try {
                await Notification.requestPermission();
            } catch (e) {
                console.warn('Notification permission request failed', e);
            }
        }
    },

    async startPersistence() {
        // 1. Wake Lock
        if ('wakeLock' in navigator && !this.wakeLock) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) { console.warn('Wake Lock Error:', err); }
        }

        // 2. Video Loop Play
        if (this.video) {
            this.video.play().catch(e => console.warn('Video Play Error:', e));
        }
    },

    stopPersistence() {
        // Only stop if nothing is running
        if (Timer.isRunning || Stopwatch.running) return;

        if (this.wakeLock) {
            this.wakeLock.release().then(() => { this.wakeLock = null; });
        }
        if (this.video) {
            this.video.pause();
        }
    },

    sendNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    }
};
