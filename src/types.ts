import { type Static, Type } from "typebox";

export const CONFIG_SYNC_SCHEMA_VERSION = 1 as const;

const SchemaVersionSchema = Type.Literal(CONFIG_SYNC_SCHEMA_VERSION);
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const GitCommitSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const ArtifactIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const TimestampSchema = Type.String({ minLength: 1 });
const PathSchema = Type.String({ minLength: 1 });
const ScopeSchema = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });

export const FileFingerprintSchema = Type.Object(
	{
		executable: Type.Boolean(),
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

export const FileInventorySchema = Type.Record(Type.String(), FileFingerprintSchema);

export const RepositoryConfigSchema = Type.Object(
	{
		branch: Type.String({ minLength: 1 }),
		repositoryPath: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const ScopeApprovalSchema = Type.Object(
	{
		approvedInPlanId: Sha256Schema,
		requestedScope: ScopeSchema,
	},
	{ additionalProperties: false },
);

export const LocalPolicySchema = Type.Object(
	{
		acceptedSharedScope: ScopeSchema,
		approvedScope: ScopeSchema,
		machineOnlySettings: Type.Array(Type.String({ pattern: "^/" }), { uniqueItems: true }),
		pendingScopeApproval: Type.Optional(ScopeApprovalSchema),
	},
	{ additionalProperties: false },
);

export const ConfigDocumentSchema = Type.Object(
	{
		policy: LocalPolicySchema,
		repository: RepositoryConfigSchema,
		schemaVersion: SchemaVersionSchema,
	},
	{ additionalProperties: false },
);

export const BaselineSchema = Type.Object(
	{
		commit: GitCommitSchema,
		files: FileInventorySchema,
	},
	{ additionalProperties: false },
);

export const JournalStageSchema = Type.Union([
	Type.Literal("prepared"),
	Type.Literal("candidate_created"),
	Type.Literal("shared_published"),
	Type.Literal("backup_verified"),
	Type.Literal("machine_files_applied"),
	Type.Literal("packages_applied"),
	Type.Literal("final_verified"),
	Type.Literal("state_committed"),
	Type.Literal("complete"),
]);

export const PendingOperationSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("pending_apply"),
			planId: Sha256Schema,
			publishedCommit: GitCommitSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("recovery"),
			planId: Sha256Schema,
			stage: JournalStageSchema,
		},
		{ additionalProperties: false },
	),
]);

export const StateDocumentSchema = Type.Object(
	{
		baseline: Type.Union([BaselineSchema, Type.Null()]),
		deviceId: ArtifactIdSchema,
		lastBackupId: Type.Union([ArtifactIdSchema, Type.Null()]),
		lastSuccessTime: Type.Union([TimestampSchema, Type.Null()]),
		pendingOperation: Type.Union([PendingOperationSchema, Type.Null()]),
		schemaVersion: SchemaVersionSchema,
	},
	{ additionalProperties: false },
);

export const PlanArtifactSchema = Type.Object(
	{
		baselineCommit: Type.Union([GitCommitSchema, Type.Null()]),
		createdAt: TimestampSchema,
		effectivePaths: Type.Array(PathSchema, { uniqueItems: true }),
		machineFingerprint: Sha256Schema,
		mode: Type.Union([Type.Literal("publish"), Type.Literal("apply"), Type.Literal("reconcile")]),
		packageFingerprint: Sha256Schema,
		planId: Sha256Schema,
		policyFingerprint: Sha256Schema,
		schemaVersion: SchemaVersionSchema,
		sharedCommit: Type.Union([GitCommitSchema, Type.Null()]),
		sharedFingerprint: Sha256Schema,
		scopeExpansion: Type.Union([ScopeSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export const OperationJournalSchema = Type.Object(
	{
		backupId: Type.Optional(ArtifactIdSchema),
		planId: Sha256Schema,
		publishedCommit: Type.Optional(GitCommitSchema),
		reviewedSharedCommit: Type.Union([GitCommitSchema, Type.Null()]),
		schemaVersion: SchemaVersionSchema,
		stage: JournalStageSchema,
		updatedAt: TimestampSchema,
	},
	{ additionalProperties: false },
);

export const BackupEntryMetadataSchema = Type.Object(
	{
		executable: Type.Union([Type.Boolean(), Type.Null()]),
		existed: Type.Boolean(),
		path: PathSchema,
		sha256: Type.Union([Sha256Schema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export const BackupMetadataSchema = Type.Object(
	{
		backupId: ArtifactIdSchema,
		createdAt: TimestampSchema,
		entries: Type.Array(BackupEntryMetadataSchema),
		planId: Sha256Schema,
		schemaVersion: SchemaVersionSchema,
	},
	{ additionalProperties: false },
);

export type FileFingerprint = Static<typeof FileFingerprintSchema>;
export type FileInventory = Static<typeof FileInventorySchema>;
export type RepositoryConfig = Static<typeof RepositoryConfigSchema>;
export type ScopeApproval = Static<typeof ScopeApprovalSchema>;
export type LocalPolicy = Static<typeof LocalPolicySchema>;
export type ConfigDocument = Static<typeof ConfigDocumentSchema>;
export type Baseline = Static<typeof BaselineSchema>;
export type StateDocument = Static<typeof StateDocumentSchema>;
export type PlanArtifact = Static<typeof PlanArtifactSchema>;
export type OperationJournal = Static<typeof OperationJournalSchema>;
export type BackupMetadata = Static<typeof BackupMetadataSchema>;
