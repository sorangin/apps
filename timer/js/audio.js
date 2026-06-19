const AudioMgr = {
    ctx: null,
    timer: null,
    currentSource: null,
    clockInterval: null,
    watchId: null, // Added watchId property

    stopTracking() {
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
    },

    init() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        Background.init();
    },

    updateClock() {
        const el = document.getElementById('ring-current-time');
        if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },

    startSound(customSoundId = null) {
        this.init();
        if (navigator.vibrate) navigator.vibrate([1000, 500, 1000, 500]);
        this.stopSound(false);

        if (customSoundId) {
            MusicStore.get(customSoundId).then(blob => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.loop = true;
                    audio.play().catch(e => console.error("Play error", e));
                    this.currentSource = audio;
                } else {
                    this.playDefaultBeep();
                }
            }).catch(() => this.playDefaultBeep());
        } else {
            this.playDefaultBeep();
        }
    },

    playDefaultBeep() {
        const playNoise = () => {
            if (!this.ctx) return;
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().catch(e => console.warn('Ctx resume failed', e));
            }
            const t = this.ctx.currentTime;
            const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
            o.connect(g); g.connect(this.ctx.destination);
            o.type = 'sine'; o.frequency.setValueAtTime(440, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.1);
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.05); g.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
            o.start(t); o.stop(t + 0.5);
        };
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(playNoise, 1000);
        playNoise();
    },

    stopSound(vibrate = true) {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.currentSource) {
            this.currentSource.pause();
            URL.revokeObjectURL(this.currentSource.src);
            this.currentSource = null;
        }
        if (vibrate && navigator.vibrate) navigator.vibrate(0);
    },

    startAlarm(soundId = null, title = "Alarm") {
        this.startSound(soundId);
        Background.sendNotification(title, "Time to wake up!");
        document.getElementById('alarm-ring-overlay').style.display = 'flex';
        this.updateClock();
        if (this.clockInterval) clearInterval(this.clockInterval);
        this.clockInterval = setInterval(() => this.updateClock(), 1000);
    },

    stopAlarm() {
        this.stopSound();
        Background.stopPersistence();
        document.getElementById('alarm-ring-overlay').style.display = 'none';
        if (this.clockInterval) {
            clearInterval(this.clockInterval);
            this.clockInterval = null;
        }
    }
};

const MusicStore = {
    dbName: 'TimerDB', storeName: 'custom_audio', db: null,
    init() {
        return new Promise((resolve, reject) => {
            if (this.db) return resolve(this.db);
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = (e) => reject(e);
        });
    },
    save(key, blob) {
        return this.init().then(db => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(blob, key);
        });
    },
    get(key) {
        return this.init().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const req = tx.objectStore(this.storeName).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        });
    }
};
