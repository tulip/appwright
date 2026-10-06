import { describe, expect, test } from 'vitest';
//@ts-ignore
import { Client as WebDriverClient } from 'webdriver';

import { Device } from '../device';
import { AppwrightLocator } from '../types';

function device(isAndroid: boolean): Device {
  //@ts-ignore partial mock: locator construction never touches the session
  const client: WebDriverClient = { isAndroid };
  return new Device(client, 'com.example.app', { expectTimeout: 1_000 }, 'emulator');
}

/** The selector and strategy the locator will send to Appium. Read through the native-context Proxy. */
function compiled(locator: AppwrightLocator): { selector: string; findStrategy: string } {
  const { selector, findStrategy } = locator as unknown as {
    selector: string;
    findStrategy: string;
  };
  return { selector, findStrategy };
}

describe('getByLabel', () => {
  test('Android: content-desc via UiSelector.description, exact by default', () => {
    expect(compiled(device(true).getByLabel('Station Name'))).toEqual({
      selector: 'new UiSelector().description("Station Name")',
      findStrategy: '-android uiautomator',
    });
  });

  test('Android: descriptionContains when exact is false', () => {
    expect(compiled(device(true).getByLabel('Station', { exact: false })).selector).toBe(
      'new UiSelector().descriptionContains("Station")',
    );
  });

  test('Android: editable narrows to text fields, autocomplete ones included', () => {
    expect(compiled(device(true).getByLabel('URL', { editable: true })).selector).toBe(
      'new UiSelector().description("URL").classNameMatches(".*(EditText|AutoCompleteTextView)")',
    );
  });

  test('iOS: label predicate, exact by default', () => {
    expect(compiled(device(false).getByLabel('Station Name'))).toEqual({
      selector: 'label == "Station Name"',
      findStrategy: '-ios predicate string',
    });
  });

  test('iOS: CONTAINS when exact is false, and editable adds the type filter', () => {
    expect(compiled(device(false).getByLabel('Station', { exact: false })).selector).toBe(
      'label CONTAINS "Station"',
    );
    expect(compiled(device(false).getByLabel('URL', { editable: true })).selector).toBe(
      'label == "URL" AND type IN {"XCUIElementTypeTextField", "XCUIElementTypeSecureTextField", "XCUIElementTypeTextView"}',
    );
  });

  test('escapes quotes and backslashes in the label', () => {
    expect(compiled(device(true).getByLabel('Say "hi" \\ bye')).selector).toBe(
      'new UiSelector().description("Say \\"hi\\" \\\\ bye")',
    );
    expect(compiled(device(false).getByLabel('Say "hi"')).selector).toBe('label == "Say \\"hi\\""');
  });
});

describe('getById', () => {
  test('is exact by default on both platforms', () => {
    expect(compiled(device(true).getById('com.example.app:id/login')).selector).toBe(
      'resourceId("com.example.app:id/login")',
    );
    expect(compiled(device(false).getById('login')).selector).toBe('name == "login"');
  });

  test('editable narrows to text fields on both platforms', () => {
    expect(compiled(device(true).getById('android:id/title', { editable: true })).selector).toBe(
      'new UiSelector().resourceId("android:id/title").classNameMatches(".*(EditText|AutoCompleteTextView)")',
    );
    expect(compiled(device(true).getById('title', { exact: false, editable: true })).selector).toBe(
      'new UiSelector().resourceIdMatches(".*title.*").classNameMatches(".*(EditText|AutoCompleteTextView)")',
    );
    expect(
      compiled(device(false).getById('DOCPicker.filenameTextField', { editable: true })),
    ).toEqual({
      selector:
        'name == "DOCPicker.filenameTextField" AND type IN {"XCUIElementTypeTextField", "XCUIElementTypeSecureTextField", "XCUIElementTypeTextView"}',
      findStrategy: '-ios predicate string',
    });
  });

  test('does not filter matches on their text, which is not the id', () => {
    const locator = device(true).getById('android:id/title') as unknown as {
      textToMatch?: string;
    };
    expect(locator.textToMatch).toBeUndefined();
  });

  test('substring mode escapes regex metacharacters on Android', () => {
    expect(compiled(device(true).getById('id/login+1', { exact: false })).selector).toBe(
      'resourceIdMatches(".*id/login\\\\+1.*")',
    );
    expect(compiled(device(false).getById('login', { exact: false })).selector).toBe(
      'name CONTAINS "login"',
    );
  });
});

describe('getByText', () => {
  test('escapes quotes in the text on both platforms', () => {
    expect(compiled(device(true).getByText('Say "hi"', { exact: true })).selector).toBe(
      'text("Say \\"hi\\"")',
    );
    expect(compiled(device(false).getByText('Say "hi"')).selector).toBe(
      'label CONTAINS "Say \\"hi\\""',
    );
  });
});

describe('getByIosPredicate / getByAndroidUiAutomator', () => {
  test('pass the raw selector through with its strategy', () => {
    expect(compiled(device(false).getByIosPredicate('value == "On"'))).toEqual({
      selector: 'value == "On"',
      findStrategy: '-ios predicate string',
    });
    expect(
      compiled(device(true).getByAndroidUiAutomator('new UiSelector().checkable(true)')),
    ).toEqual({
      selector: 'new UiSelector().checkable(true)',
      findStrategy: '-android uiautomator',
    });
  });
});
