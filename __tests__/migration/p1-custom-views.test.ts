/**
 * P1-6 · custom View detection (inheritance→composition rewrite anchor).
 *
 * The AntennaPod dogfood pass silently missed that a class extending an Android
 * View can't be translated 1:1 to ArkUI (which has no UI class inheritance).
 * `isAndroidViewSuper` classifies a supertype base name; combined with the
 * Kotlin `superTypes` parser it recovers custom Views from source headers (the
 * code graph's `extends` edge is useless here — the framework View base has no
 * node in the repo's graph).
 */

import { describe, it, expect } from 'vitest';
import { isAndroidViewSuper } from '../../src/appgraph/detect/roles';
import { superTypes } from '../../src/appgraph/detect/kotlin-source';

describe('P1-6 · isAndroidViewSuper', () => {
  it('accepts View bases: containers, widgets, and the explicit set', () => {
    for (const s of ['View', 'ViewGroup', 'LinearLayout', 'FrameLayout', 'ConstraintLayout',
      'TextView', 'AppCompatTextView', 'RecyclerView', 'ScrollView', 'AppCompatButton',
      'ImageButton', 'ProgressBar', 'SeekBar', 'Toolbar', 'EditText', 'CheckBox', 'Switch']) {
      expect(isAndroidViewSuper(s), s).toBe(true);
    }
  });

  it('rejects non-View supertypes', () => {
    for (const s of ['ViewModel', 'Activity', 'Fragment', 'Repository', 'Bar', 'Car',
      'Any', 'Serializable', 'RecyclerViewAdapter', 'Parcelable']) {
      // `ViewModel` ends in `Model` not a View suffix; `RecyclerViewAdapter`
      // ends in `Adapter`; short words are rejected by the length guard.
      expect(isAndroidViewSuper(s), s).toBe(false);
    }
  });
});

describe('P1-6 · superTypes + isAndroidViewSuper on real headers', () => {
  const detect = (code: string): string | undefined => superTypes(code).find(isAndroidViewSuper);

  it('finds the View base of a custom view, ignoring interfaces/generics', () => {
    expect(detect('class ChapterSeekBar(ctx: Context) : SeekBar(ctx) { }')).toBe('SeekBar');
    expect(
      detect('class EqualizerBar : LinearLayout, View.OnClickListener { override fun x() {} }')
    ).toBe('LinearLayout');
    expect(
      detect('class PlaybackController(private val a: Activity) : ViewModel() { }')
    ).toBeUndefined();
    expect(detect('data class Episode(val id: Long) : Parcelable { }')).toBeUndefined();
  });
});
