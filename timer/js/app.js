const App = {
    tabs: ['timer', 'alarm', 'stopwatch'], currentIdx: 0,

    init() {
        // Nav Trigger
        const nav = document.getElementById('bottom-nav');
        document.querySelector('.nav-trigger').addEventListener('mouseenter', () => nav.classList.add('visible'));
        nav.addEventListener('mouseleave', () => nav.classList.remove('visible'));
        // Mobile touch trigger
        document.querySelector('.nav-trigger').addEventListener('touchstart', () => {
            nav.classList.toggle('visible');
        });

        // Init Modules
        AudioMgr.init();
        Timer.init();
        Alarm.init();
        Stopwatch.init();

        // Keyboard Navigation
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;
            if (e.key === 'ArrowLeft') this.prevTab();
            if (e.key === 'ArrowRight') this.nextTab();
        });

        // Swipe Navigation (Mobile)
        let touchStartX = 0;
        window.addEventListener('touchstart', e => touchStartX = e.changedTouches[0].screenX);
        window.addEventListener('touchend', e => {
            const diff = e.changedTouches[0].screenX - touchStartX;
            if (Math.abs(diff) > 50) {
                Background.requestNotificationPermission();
                if (diff > 0) this.prevTab(); else this.nextTab();
            }
        });

        // Trackpad Swipe (Desktop)
        let wheelAcc = 0;
        window.addEventListener('wheel', e => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                e.preventDefault(); // Prevent browser back/forward
                wheelAcc += e.deltaX;
                if (Math.abs(wheelAcc) > 150) {
                    Background.requestNotificationPermission();
                    if (wheelAcc > 0) this.nextTab(); else this.prevTab();
                    wheelAcc = 0;
                }
            } else {
                wheelAcc = 0;
            }
        }, { passive: false });

        // PWA Registration
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').catch(err => console.log('SW Registration failed:', err));
            });
        }
    },

    prevTab() { if (this.currentIdx > 0) this.switchTab(this.tabs[this.currentIdx - 1]); },
    nextTab() { if (this.currentIdx < this.tabs.length - 1) this.switchTab(this.tabs[this.currentIdx + 1]); },

    switchTab(id, el) {
        Background.requestNotificationPermission();
        if (typeof Timer !== 'undefined' && Timer.container && Timer.container.classList.contains('finished')) {
            Timer.resetAfterFinish();
        }

        // Pop up nav briefly
        const nav = document.getElementById('bottom-nav');
        if (nav) {
            nav.classList.add('visible');
            if (this.navTimer) clearTimeout(this.navTimer);
            this.navTimer = setTimeout(() => nav.classList.remove('visible'), 2000);
        }

        if (this.tabs[this.currentIdx] === id) {
            if (id === 'stopwatch') Stopwatch.toggleTracking();
            return;
        }
        this.currentIdx = this.tabs.indexOf(id);
        document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
        document.getElementById(`view-${id}`).classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        if (el) el.classList.add('active'); else document.getElementById(`nav-${id}`).classList.add('active');

        const fab = document.getElementById('fab-add-alarm');
        if (fab) fab.style.display = (id === 'alarm') ? 'flex' : 'none';
    }
};

window.addEventListener('DOMContentLoaded', () => App.init());
