/**
 * Deterministic state machine for form submission lifecycles (Record intake & Public forms).
 * Eliminates loose boolean combinations (`busy`, `errors`, `submitError`, `done`).
 */

export type FormSubmissionStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface FormSubmissionState<TResult = unknown> {
  status: FormSubmissionStatus;
  errors: Record<string, string>;
  error: unknown | null;
  result: TResult | null;
}

export type FormSubmissionEvent<TResult = unknown> =
  | { type: 'SUBMIT' }
  | { type: 'SUCCESS'; result: TResult }
  | { type: 'ERROR'; error: unknown; errors?: Record<string, string> }
  | { type: 'RESET' };

export function initialFormSubmissionState<TResult = unknown>(): FormSubmissionState<TResult> {
  return {
    status: 'idle',
    errors: {},
    error: null,
    result: null,
  };
}

export function formSubmissionReducer<TResult = unknown>(
  state: FormSubmissionState<TResult>,
  event: FormSubmissionEvent<TResult>,
): FormSubmissionState<TResult> {
  switch (event.type) {
    case 'SUBMIT':
      return {
        ...state,
        status: 'submitting',
        error: null,
        errors: {},
      };
    case 'SUCCESS':
      return {
        status: 'success',
        result: event.result,
        error: null,
        errors: {},
      };
    case 'ERROR':
      return {
        ...state,
        status: 'error',
        error: event.error,
        errors: event.errors ?? {},
      };
    case 'RESET':
      return initialFormSubmissionState<TResult>();
  }
}

export const isSubmitting = <T>(s: FormSubmissionState<T>): boolean => s.status === 'submitting';
export const isSuccess = <T>(s: FormSubmissionState<T>): boolean => s.status === 'success';
