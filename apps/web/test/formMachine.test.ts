import { describe, expect, it } from 'vitest';
import {
  formSubmissionReducer,
  initialFormSubmissionState,
  isSubmitting,
  isSuccess,
} from '../src/lib/formMachine';

describe('formSubmissionReducer state machine', () => {
  it('starts in idle status', () => {
    const s = initialFormSubmissionState();
    expect(s.status).toBe('idle');
    expect(s.errors).toEqual({});
    expect(s.error).toBeNull();
    expect(s.result).toBeNull();
    expect(isSubmitting(s)).toBe(false);
    expect(isSuccess(s)).toBe(false);
  });

  it('transitions idle -> submitting on SUBMIT, clearing previous errors', () => {
    const errState = formSubmissionReducer(
      initialFormSubmissionState(),
      { type: 'ERROR', error: new Error('bad input'), errors: { name: 'required' } },
    );
    const submitting = formSubmissionReducer(errState, { type: 'SUBMIT' });

    expect(submitting.status).toBe('submitting');
    expect(submitting.error).toBeNull();
    expect(submitting.errors).toEqual({});
    expect(isSubmitting(submitting)).toBe(true);
  });

  it('transitions submitting -> success on SUCCESS with payload', () => {
    const submitting = formSubmissionReducer(initialFormSubmissionState(), { type: 'SUBMIT' });
    const success = formSubmissionReducer(submitting, {
      type: 'SUCCESS',
      result: { id: 'rec-1', number: 101 },
    });

    expect(success.status).toBe('success');
    expect(success.result).toEqual({ id: 'rec-1', number: 101 });
    expect(isSuccess(success)).toBe(true);
    expect(isSubmitting(success)).toBe(false);
  });

  it('transitions submitting -> error on ERROR', () => {
    const submitting = formSubmissionReducer(initialFormSubmissionState(), { type: 'SUBMIT' });
    const errorState = formSubmissionReducer(submitting, {
      type: 'ERROR',
      error: 'Network failure',
      errors: { email: 'invalid email' },
    });

    expect(errorState.status).toBe('error');
    expect(errorState.error).toBe('Network failure');
    expect(errorState.errors).toEqual({ email: 'invalid email' });
    expect(isSubmitting(errorState)).toBe(false);
  });

  it('resets cleanly back to initial state on RESET', () => {
    const s = formSubmissionReducer(
      initialFormSubmissionState(),
      { type: 'SUCCESS', result: { id: 'done' } },
    );
    const reset = formSubmissionReducer(s, { type: 'RESET' });
    expect(reset.status).toBe('idle');
    expect(reset.result).toBeNull();
  });
});
