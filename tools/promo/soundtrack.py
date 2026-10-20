"""Synthesises the promo's soundtrack: a light 120 bpm bed (pad, bass, pluck
arpeggio, kick and hats) plus sound effects lined up with promo.html's
timeline. Everything is generated here, so there is no third-party audio to
license.

    python3 soundtrack.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 30.0
BEAT = 0.5  # 120 bpm
N = int(SR * DUR)


def note(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(n, a, r, sus=1.0):
    """Attack, then an exponential release over the whole length."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / r) * sus
    return e


def lowpass(x, cutoff):
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += alpha * (v - acc)
        y[i] = acc
    return y


def add(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i >= len(buf):
        return
    sig = sig[: len(buf) - i]
    buf[i : i + len(sig)] += sig * gain


def tone(freq, length, shape="sine"):
    t = np.arange(int(length * SR)) / SR
    ph = 2 * np.pi * freq * t
    if shape == "tri":
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if shape == "saw":
        return 2 * ((freq * t) % 1) - 1
    return np.sin(ph)


music = np.zeros(N)
sfx = np.zeros(N)

# Chords, two bars each: Cmaj7, Am7, Fmaj7, G6.
CHORDS = [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 55, 59]]
BAR = 4 * BEAT

# Pad, from the start, swelling in.
t0 = 0.0
k = 0
while t0 < DUR:
    ch = CHORDS[k % 4]
    length = 2 * BAR + 0.6
    for m in ch[1:]:
        sig = sum(tone(note(m + 12) * d, length, "saw") for d in (0.997, 1.003)) / 2
        sig = lowpass(sig, 1400)
        n = len(sig)
        e = np.minimum(1, np.arange(n) / (0.5 * SR)) * np.minimum(1, (n - np.arange(n)) / (0.6 * SR))
        add(music, t0, sig * e, 0.045)
    t0 += 2 * BAR
    k += 1

# Bass, kick, hats and arpeggio once the phone is on screen (2.75 s, near a beat).
start = 2.5
end = 25.5
t = start
step = 0
while t < end:
    bar_i = int((t - 0.0) // (2 * BAR)) % 4
    ch = CHORDS[bar_i]
    beat_in_bar = step % 8  # eighths
    if beat_in_bar % 2 == 0:
        # kick on every beat
        n = int(0.35 * SR)
        tt = np.arange(n) / SR
        f = 45 + 85 * np.exp(-tt * 28)
        kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9)
        add(music, t, kick, 0.55 if t > 3.4 else 0.25)
        # bass on the root, eighth-note pulse feel
        b = tone(note(ch[0] - 12), 0.45, "tri") * env(int(0.45 * SR), 0.005, 0.25)
        add(music, t, lowpass(b, 600), 0.32)
    else:
        # hats on the offbeats, after the first scene
        if t > 7.5:
            n = int(0.06 * SR)
            noise = np.random.default_rng(step).standard_normal(n)
            hat = (noise - lowpass(noise, 7000)) * np.exp(-np.arange(n) / SR * 60)
            add(music, t, hat, 0.12)
    # pluck arpeggio, sixteenth-ish sparkle every eighth
    if t > 3.4:
        m = ch[[1, 2, 3, 2][step % 4]] + 24
        pl = tone(note(m), 0.4, "tri") * env(int(0.4 * SR), 0.003, 0.09)
        add(music, t, pl, 0.07)
    t += BEAT / 2
    step += 1

# Final chord at the end card, ringing out.
for m in [48, 55, 59, 64, 71]:
    sig = tone(note(m + 12), 4.5, "tri") * env(int(4.5 * SR), 0.01, 1.4)
    add(music, 25.9, lowpass(sig, 2500), 0.07)
b = tone(note(36), 4.0, "sine") * env(int(4.0 * SR), 0.01, 1.2)
add(music, 25.9, b, 0.3)


# --- sound effects -----------------------------------------------------------
def ping(at, base, gain=0.22):
    for i, (m, dt) in enumerate([(base, 0.0), (base + 7, 0.09)]):
        s = tone(note(m), 0.7) * env(int(0.7 * SR), 0.002, 0.18)
        s += 0.3 * tone(note(m + 12), 0.7) * env(int(0.7 * SR), 0.002, 0.1)
        add(sfx, at + dt, s, gain)


def whoosh(at, length=0.45, gain=0.10):
    n = int(length * SR)
    noise = np.random.default_rng(int(at * 100)).standard_normal(n)
    sweep = np.sin(np.linspace(0, np.pi, n)) ** 2
    add(sfx, at, lowpass(noise, 2200) * sweep, gain)


ping(3.75, 79)                      # bank notification
ping(5.85, 84, 0.26)                # Bussola notification
n = int(0.05 * SR)                  # tap on Accetta
add(sfx, 9.9, lowpass(np.random.default_rng(1).standard_normal(n), 3000) * np.exp(-np.arange(n) / SR * 90), 0.5)
for i, m in enumerate([72, 76, 79, 84]):  # "registrato"
    s = tone(note(m), 0.5) * env(int(0.5 * SR), 0.002, 0.12)
    add(sfx, 10.6 + i * 0.06, s, 0.12)
for at in (7.5, 12.15, 16.55, 20.95, 25.5):
    whoosh(at)
whoosh(0.1, 1.0, 0.08)

mix = music + sfx
# fades
fade_in = np.minimum(1, np.arange(N) / (0.3 * SR))
fade_out = np.minimum(1, (N - np.arange(N)) / (1.5 * SR))
mix *= fade_in * fade_out
mix /= np.max(np.abs(mix)) / 0.89
stereo = np.stack([mix, mix], axis=1)
pcm = (stereo * 32767).astype(np.int16)
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "soundtrack.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
