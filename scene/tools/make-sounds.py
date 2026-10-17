#!/usr/bin/env python3
"""
Synthesises the scene's sound effects, so the project carries no sampled audio it would
have to license and the clips can be re-tuned by changing a number here.

    cd scene
    python3 tools/make-sounds.py

Output: sounds/*.mp3, mono 22 kHz, which is plenty for engine noise over a WebSocket race
and keeps the whole set under a hundred kilobytes.

The four loops are built to be seamless: every partial gets a whole number of cycles in the
buffer, and the last few milliseconds crossfade into the first, so `AudioSource.loop` has no
click to expose. The engine clip is deliberately flat in pitch — the scene scales it with
`pitch` from the car's speed, and a clip that already sweeps would fight that.
"""

import math
import os
import subprocess
import sys

import numpy as np

RATE = 22050
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'sounds')


def t(seconds):
    return np.arange(int(RATE * seconds)) / RATE


def cycles(freq, seconds):
    """`freq` rounded so a whole number of cycles fits in `seconds`: the loop's whole trick."""
    return max(1, round(freq * seconds)) / seconds


def tone(freq, seconds, kind='sine'):
    phase = 2 * math.pi * cycles(freq, seconds) * t(seconds)
    if kind == 'saw':
        # Band-limited enough for this: a handful of harmonics instead of a hard ramp.
        out = sum(np.sin(phase * h) / h for h in range(1, 9))
        return out / 2
    if kind == 'square':
        return np.sign(np.sin(phase)) * 0.4
    return np.sin(phase)


def noise(seconds, seed):
    return np.random.default_rng(seed).uniform(-1, 1, int(RATE * seconds))


def lowpass(signal, cutoff):
    """One-pole filter. Cheap, and the only shaping these clips need."""
    a = math.exp(-2 * math.pi * cutoff / RATE)
    out = np.empty_like(signal)
    acc = 0.0
    for i, sample in enumerate(signal):
        acc = sample * (1 - a) + acc * a
        out[i] = acc
    return out


def highpass(signal, cutoff):
    return signal - lowpass(signal, cutoff)


def seamless(signal, fade=0.02):
    """Crossfade the tail into the head so the loop point is inaudible."""
    n = int(RATE * fade)
    if n * 2 >= len(signal):
        return signal
    ramp = np.linspace(0, 1, n)
    head = signal[:n] * ramp + signal[-n:] * (1 - ramp)
    out = signal[:-n].copy()
    out[:n] = head
    return out


def normalise(signal, peak=0.89):
    high = np.max(np.abs(signal)) or 1.0
    return signal / high * peak


def write(name, signal, bitrate='64k'):
    pcm = (normalise(signal) * 32767).astype('<i2').tobytes()
    path = os.path.join(OUT, f'{name}.mp3')
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 's16le', '-ar', str(RATE), '-ac', '1',
         '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', bitrate, path],
        input=pcm, check=True
    )
    print(f'{os.path.relpath(path, os.path.dirname(OUT))}  {os.path.getsize(path) // 1024} KB  '
          f'{len(signal) / RATE:.2f}s')


# ---------------------------------------------------------------- the clips

def engine_loop():
    """
    An electric car, so: a motor whine over a drivetrain hum, not a combustion engine.

    Two whine partials an octave apart carry most of it, a low hum gives it weight, and a
    whisper of filtered noise stands in for tyre roar. The scene plays this at a pitch
    proportional to road speed, which is what turns it into acceleration.
    """
    d = 2.0
    whine = tone(420, d) * 0.5 + tone(840, d) * 0.22 + tone(1260, d, 'saw') * 0.08
    hum = tone(105, d, 'saw') * 0.45 + tone(52, d) * 0.3
    roar = lowpass(noise(d, 11), 900) * 0.25
    # Nothing is modulated on purpose. An earlier version put a 3 Hz tremolo over the
    # partials so a held note would not sound frozen; at constant speed that reads as the
    # car changing gear three times a second, which is worse than a flat drone. The sense
    # of motion has to come from the pitch the scene applies, not from the clip.
    return seamless(whine + hum + roar)


def brake_loop():
    """Locked tyres: a narrow screech riding on a band of grit."""
    d = 1.6
    squeal = tone(1150, d) * 0.5 + tone(1730, d) * 0.25
    squeal *= 1 + 0.35 * tone(cycles(17, d), d)  # the wobble that makes it a skid
    grit = highpass(lowpass(noise(d, 23), 3200), 700) * 0.9
    return seamless(squeal * 0.55 + grit)


def boost_loop():
    """Rear flare: a jet roar with a rising edge of air over it."""
    d = 2.0
    core = lowpass(noise(d, 31), 1400) * 1.0
    air = highpass(noise(d, 37), 2600) * 0.45
    rumble = tone(70, d, 'saw') * 0.35 + tone(140, d) * 0.2
    return seamless(core + air + rumble)


def thruster_loop():
    """Cold gas: hiss, a resonant throat and almost no low end."""
    d = 2.0
    hiss = highpass(noise(d, 41), 1800) * 0.9
    throat = lowpass(noise(d, 43), 600) * 0.5
    ring = tone(330, d) * 0.12 + tone(660, d) * 0.06
    return seamless(hiss + throat + ring)


def gravel_loop():
    """
    Stones under the floorpan: a broad rattle with no pitch to it.

    Deliberately band-limited and grainy rather than a clean hiss — the thruster clip is
    already a hiss, and the two have to be told apart with the engine running over both.
    """
    d = 2.0
    rng = np.random.default_rng(17)
    bed = lowpass(noise(d, 19), 2600) * 0.7
    # Individual stones: short ticks scattered densely enough to read as a rattle.
    stones = np.zeros(int(RATE * d))
    for _ in range(700):
        at = rng.uniform(0, d - 0.01)
        start = int(at * RATE)
        length = int(RATE * rng.uniform(0.002, 0.006))
        burst = rng.uniform(-1, 1, length) * np.exp(-np.linspace(0, 6, length))
        stones[start:start + length] += burst * rng.uniform(0.3, 1.0)
    return seamless(bed + highpass(stones, 1200) * 0.8)


def applause():
    """
    A crowd, built one pair of hands at a time.

    Each clap is a short noise burst with a fast decay; a few hundred of them scattered over
    the clip, dense at the front and thinning out, read as applause. A bed of filtered noise
    underneath is the room and the voices.
    """
    d = 2.6
    rng = np.random.default_rng(5)
    out = np.zeros(int(RATE * d))
    claps = 420
    for _ in range(claps):
        # Front-loaded: the crowd reacts at once, then trails off.
        at = min(d - 0.05, abs(rng.normal(0.45, 0.55)))
        start = int(at * RATE)
        length = int(RATE * rng.uniform(0.012, 0.03))
        burst = rng.uniform(-1, 1, length)
        burst *= np.exp(-np.linspace(0, 9, length))
        gain = rng.uniform(0.25, 1.0) * (1 - at / d * 0.6)
        out[start:start + length] += burst * gain
    out = highpass(out, 900)
    bed = lowpass(noise(d, 7), 2000) * 0.22
    bed *= np.clip(np.exp(-t(d) * 1.1), 0, 1)
    tail = np.clip(1.15 - t(d) / d, 0, 1)
    return (out + bed) * tail


def main():
    if not OUT.endswith('sounds'):
        sys.exit('unexpected output directory')
    os.makedirs(OUT, exist_ok=True)
    write('engine', engine_loop())
    write('brake', brake_loop())
    write('boost', boost_loop())
    write('thruster', thruster_loop())
    write('gravel', gravel_loop())
    write('applause', applause(), bitrate='80k')


if __name__ == '__main__':
    main()
