import { useEffect, useMemo } from 'react';
import { useStore } from '../state/store';
import { formatDuration, todayKey } from '../lib/util';
import { Icon, Slider } from './ui';

const dayKey = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return todayKey(d);
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default function Stats(): JSX.Element {
  const stats = useStore((s) => s.stats);
  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);
  const navigate = useStore((s) => s.navigate);
  const refreshStats = useStore((s) => s.refreshStats);
  const library = useStore((s) => s.library);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const goalSeconds = settings.goals.dailyMinutes * 60;
  const todaySeconds = stats.days[todayKey()] ?? 0;
  const ratio = Math.min(1, goalSeconds ? todaySeconds / goalSeconds : 0);

  const streak = useMemo(() => {
    let n = 0;
    // A day still in progress must not break yesterday's streak.
    let i = (stats.days[dayKey(0)] ?? 0) >= 60 ? 0 : 1;
    for (; i < 3650; i++) {
      if ((stats.days[dayKey(i)] ?? 0) >= 60) n++;
      else break;
    }
    return n;
  }, [stats.days]);

  /**
   * Four weeks, oldest first — a calendar, not a progress bar.
   *
   * Reading this chart as progress ("I only started today, why am I at the far right?")
   * is a fair mistake when the only labels are the two ends. So every bar now carries its
   * weekday underneath and Mondays carry the date, which makes the time axis legible at a
   * glance, and today is marked outright.
   */
  const days = useMemo(() => {
    const n = 28;
    return Array.from({ length: n }, (_, i) => {
      const offset = n - 1 - i;
      const key = dayKey(offset);
      const date = new Date();
      date.setDate(date.getDate() - offset);
      return {
        key,
        date,
        seconds: stats.days[key] ?? 0,
        today: offset === 0,
      };
    });
  }, [stats.days]);
  const peak = Math.max(goalSeconds, ...days.map((d) => d.seconds), 1);

  const weekSeconds = days.slice(-7).reduce((a, d) => a + d.seconds, 0);
  const activeDays = days.filter((d) => d.seconds >= 60).length;

  const thisYear = new Date().getFullYear();
  const finishedThisYear = stats.finished.filter((f) => new Date(f.at).getFullYear() === thisYear);
  const totalSeconds = Object.values(stats.days).reduce((a, b) => a + b, 0);

  const perBook = useMemo(() => {
    const titles = new Map(library.books.map((b) => [b.id, b.title]));
    return Object.entries(stats.byBook)
      .filter(([, s]) => s >= 60)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, seconds]) => ({ id, seconds, title: titles.get(id) ?? '已移除的书' }));
  }, [library.books, stats.byBook]);
  const bookPeak = Math.max(1, ...perBook.map((b) => b.seconds));

  const circumference = 2 * Math.PI * 34;

  return (
    <main className="main">
      <header className="topbar bordered titlebar-drag">
        <button className="btn" onClick={() => navigate({ name: 'library' })}>
          <Icon name="back" size={16} /> 书架
        </button>
        <h1>阅读统计</h1>
      </header>

      <div className="stats">
        <div className="stat-cards">
          <div className="stat-card goal-ring">
            <svg width="86" height="86" viewBox="0 0 86 86">
              <circle cx="43" cy="43" r="34" fill="none" stroke="var(--app-line)" strokeWidth="9" />
              <circle
                cx="43"
                cy="43"
                r="34"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - ratio)}
                transform="rotate(-90 43 43)"
                style={{ transition: 'stroke-dashoffset 600ms var(--ease)' }}
              />
            </svg>
            <div>
              <div className="k">今日目标</div>
              <div className="v">{Math.round(ratio * 100)}%</div>
              <div className="sub">
                {formatDuration(todaySeconds)} / {settings.goals.dailyMinutes} 分钟
              </div>
            </div>
          </div>

          <div className="stat-card">
            <div className="k">连续阅读</div>
            <div className="v">{streak} 天</div>
            <div className="sub">每天读满 1 分钟即计入</div>
          </div>

          <div className="stat-card">
            <div className="k">{thisYear} 年读完</div>
            <div className="v">{finishedThisYear.length} 本</div>
            <div className="sub">书架共 {library.books.length} 本</div>
          </div>

          <div className="stat-card">
            <div className="k">累计阅读时长</div>
            <div className="v">{Math.round(totalSeconds / 3600)} 小时</div>
            <div className="sub">{formatDuration(totalSeconds)}</div>
          </div>
        </div>

        <div className="stats-columns">
          <section className="stat-card chart-card">
            <div className="card-head">
              <h2>最近四周</h2>
              <span>
                本周 {formatDuration(weekSeconds)} · 有记录 {activeDays} 天
              </span>
            </div>
            <div className="bars">
              {days.map((d) => (
                <div className="bar-slot" key={d.key} title={`${d.key} · ${formatDuration(d.seconds)}`}>
                  <div className="bar-track">
                    <div
                      className={`bar${d.seconds >= goalSeconds && goalSeconds > 0 ? ' hit' : ''}${
                        d.today ? ' today' : ''
                      }`}
                      style={{ height: `${d.seconds > 0 ? Math.max(4, (d.seconds / peak) * 100) : 0}%` }}
                    />
                  </div>
                  <span className={`tick${d.today ? ' now' : ''}`}>
                    {d.today ? '今天' : WEEKDAYS[d.date.getDay()]}
                  </span>
                  <span className="tick faint">
                    {d.date.getDay() === 1 || d.date.getDate() === 1 ? `${d.date.getMonth() + 1}/${d.date.getDate()}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="stat-card">
            <div className="card-head">
              <h2>每日目标</h2>
            </div>
            <Slider
              label="每日阅读目标"
              value={settings.goals.dailyMinutes}
              min={5}
              max={180}
              step={5}
              format={(v) => `${v} 分钟`}
              onChange={(dailyMinutes) => patchSettings({ goals: { dailyMinutes } })}
            />
            <p className="sub" style={{ marginTop: 12 }}>
              达成后当天的柱子会变成强调色。连续达成天数会累积成上面的「连续阅读」。
            </p>
          </section>
        </div>

        <div className="stats-columns">
          <section className="stat-card">
            <div className="card-head">
              <h2>各书用时</h2>
            </div>
            {perBook.length ? (
              <div className="book-bars">
                {perBook.map((b) => (
                  <div key={b.id} className="book-bar">
                    <span className="name">{b.title}</span>
                    <span className="track">
                      <i style={{ width: `${(b.seconds / bookPeak) * 100}%` }} />
                    </span>
                    <span className="sub">{formatDuration(b.seconds)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sub">还没有满 1 分钟的阅读记录。</p>
            )}
          </section>

          <section className="stat-card">
            <div className="card-head">
              <h2>{thisYear} 年读完</h2>
            </div>
            {finishedThisYear.length ? (
              <div className="finished-list">
                {finishedThisYear.map((f) => (
                  <div key={f.bookId}>
                    <span>{f.title}</span>
                    <span className="sub">{new Date(f.at).toLocaleDateString('zh-CN')}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sub">读到最后一页时会自动记在这里。</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
