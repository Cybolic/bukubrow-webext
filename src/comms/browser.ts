import { pipe } from 'fp-ts/lib/pipeable';
import { flow } from 'fp-ts/lib/function';
import { sequenceT } from 'fp-ts/lib/Apply';
import * as O from 'fp-ts/lib/Option';
import * as T from 'fp-ts/lib/Task';
import * as TO from 'fp-ts-contrib/lib/TaskOption';
import * as TE from 'fp-ts/lib/TaskEither';
import * as A from 'fp-ts/lib/Array';
import * as NEA from 'fp-ts/lib/NonEmptyArray';
import { browser, Tabs } from 'webextension-polyfill-ts';
import { BOOKMARKS_SCHEMA_VERSION } from 'Modules/config';
import { sendIsomorphicMessage, IsomorphicMessage } from 'Comms/isomorphic';
import { createUuid } from 'Modules/uuid';
import { error } from 'Modules/error';

const sequenceTTaskEither = sequenceT(TE.taskEither);

const browserTabsQuery = (x: Tabs.QueryQueryInfoType): TO.TaskOption<Tabs.Tab[]> =>
	TO.tryCatch(() => browser.tabs.query(x));

export const getActiveTab: TO.TaskOption<Tabs.Tab> = pipe(
	browserTabsQuery({ active: true, currentWindow: true }),
	TO.chainOption(A.head),
);

export const getActiveWindowTabs: TO.TaskOption<NEA.NonEmptyArray<Tabs.Tab>> = pipe(
	browserTabsQuery({ currentWindow: true }),
	TO.chainOption(NEA.fromArray),
);

export const getAllTabs: TO.TaskOption<NEA.NonEmptyArray<Tabs.Tab>> = pipe(
	browserTabsQuery({}),
	TO.chainOption(NEA.fromArray),
);

export const onTabActivity = (cb: () => void) => {
	browser.tabs.onActivated.addListener(cb);
	browser.tabs.onUpdated.addListener(cb);
};

// The imperfect title includes check is because Firefox's href changes
// according to the extension in use, if any
const isNewTabPage = ({ url = '', title = '' }: Pick<Tabs.Tab, 'url' | 'title'>) =>
	['about:blank', 'chrome://newtab/'].includes(url) || title.includes('New Tab');

/// The active tab will not update quickly enough to allow this function to be
/// called safely in a loop. Therefore, the second argument forces consumers to
/// verify that this is only the first tab they're opening.
export const openBookmarkInAppropriateTab = async (url: string, isFirstTabToOpen: boolean) => {
	const canOpenInCurrentTab = await pipe(
		getActiveTab,
		TO.fold(
			() => T.of(false),
			flow(isNewTabPage, T.of),
		),
	)();

	// Updates active window active tab if no ID specified
	if (canOpenInCurrentTab && isFirstTabToOpen) await browser.tabs.update(undefined, { url });
	else await browser.tabs.create({ url });
};

export interface StorageState {
	bookmarks: LocalBookmark[];
	stagedBookmarksGroups: StagedBookmarksGroup[];
	bookmarksSchemaVersion: number;
}

// TODO actually verify the return type with io-ts
const getLocalStorage = <T extends keyof StorageState>(...ks: T[]): TE.TaskEither<Error, Partial<Pick<StorageState, T>>> =>
	TE.tryCatch(
		() => browser.storage.local.get(ks) as Promise<Partial<Pick<StorageState, T>>>,
		() => new Error('Failed to get local storage'),
	);

const setLocalStorage = (x: Partial<StorageState>): TE.TaskEither<Error, void> =>
	TE.tryCatch(
		() => browser.storage.local.set(x),
		() => new Error('Failed to set local storage'),
	);

export const getBookmarksFromLocalStorage: TE.TaskEither<Error, O.Option<NEA.NonEmptyArray<LocalBookmark>>> = pipe(
	getLocalStorage('bookmarks', 'bookmarksSchemaVersion'),
	// Once upon a time we tried to store tags as a Set. Chrome's extension
	// storage implementation didn't like this, but Firefox did. The change was
	// reverted, but now the tags are sometimes still stored as a set. For some
	// reason. This addresses that by ensuring any tags pulled from storage will
	// be resolved as an array, regardless of whether they're stored as an array
	// or a Set.
	TE.chain(TE.fromPredicate(
		d => d.bookmarksSchemaVersion === BOOKMARKS_SCHEMA_VERSION,
		error("Bookmark schema versions don't match"),
	)),
	TE.map(flow(
		d => O.fromNullable(d.bookmarks),
		O.chain(NEA.fromArray),
		O.map(NEA.map(bm => ({
			...bm,
			tags: Array.from(bm.tags),
		}))),
	)),
);

export const saveBookmarksToLocalStorage = (bookmarks: LocalBookmark[]): TE.TaskEither<Error, void> => pipe(
	setLocalStorage({ bookmarks, bookmarksSchemaVersion: BOOKMARKS_SCHEMA_VERSION }),
	TE.chain(() => sendIsomorphicMessage(IsomorphicMessage.BookmarksUpdatedInLocalStorage)),
);

export const getStagedBookmarksGroupsFromLocalStorage: TE.TaskEither<Error, O.Option<StagedBookmarksGroup[]>> = pipe(
	getLocalStorage('stagedBookmarksGroups'),
	TE.map(({ stagedBookmarksGroups }) => O.fromNullable(stagedBookmarksGroups)),
);

export const saveStagedBookmarksGroupsToLocalStorage = (stagedBookmarksGroups: StagedBookmarksGroup[]): TE.TaskEither<Error, void> =>
	setLocalStorage({ stagedBookmarksGroups });

export const saveStagedBookmarksAsNewGroupToLocalStorage = (newStagedBookmarks: NEA.NonEmptyArray<LocalBookmarkUnsaved>): TE.TaskEither<Error, void> => {
	const stagedBookmarksGroups = pipe(
		getStagedBookmarksGroupsFromLocalStorage,
		TE.map(O.getOrElse((): StagedBookmarksGroup[] => [])),
	);

	const newGroup = pipe(
		stagedBookmarksGroups,
		TE.map(flow(
			flow(A.map(group => group.id), createUuid),
			(id): StagedBookmarksGroup => ({
				id,
				time: new Date().getTime(),
				// Assign each bookmark a generated ID, and ensure they don't clash with
				// one another
				bookmarks: newStagedBookmarks.reduce<LocalBookmark[]>((acc, bm) => [...acc, {
					...bm,
					id: createUuid(acc.map(b => b.id)),
				}], []),
			}),
		)),
	);

	return pipe(
		sequenceTTaskEither(stagedBookmarksGroups, newGroup),
		TE.chain(([xs, y]) => setLocalStorage({ stagedBookmarksGroups: [...xs, y] })),
	);
};
