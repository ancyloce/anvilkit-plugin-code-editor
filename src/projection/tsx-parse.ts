import { parse } from "@babel/parser";
import type { Config, Field } from "@puckeditor/core";
import type { ApplyResult, Diagnostic } from "./types.js";

/** Frozen writable projection grammar documented in PRD 0023 §10. */
export const TSX_GRAMMAR_VERSION = 1 as const;

/** A parsed node before P2-02 restores identity and hidden carriers. */
export interface ParsedTsxNode {
	readonly type: string;
	readonly akId?: string;
	readonly props: Readonly<Record<string, unknown>>;
}

/** The TSX projection represents document content; root and zones stay authoritative. */
export interface ParsedTsxDocument {
	readonly content: readonly ParsedTsxNode[];
}

interface SourcePosition {
	readonly line: number;
	readonly column: number;
}

interface AstNode {
	readonly type: string;
	readonly loc?: { readonly start: SourcePosition } | null;
	readonly [key: string]: unknown;
}

type HintKey =
	| "codeEditor.hint.fields"
	| "codeEditor.hint.slots"
	| "codeEditor.hint.appearance"
	| "codeEditor.hint.interactions"
	| "codeEditor.hint.bindings";

const MAX_PARSE_DEPTH = 32;
const ARRAY_INDEX = /^i(0|[1-9]\d*)$/;
const HINT_TEXT: Readonly<Record<HintKey, string>> = {
	"codeEditor.hint.fields": "Edit this value in the component Fields panel.",
	"codeEditor.hint.slots":
		"Edit nested content through the component's declared Slots.",
	"codeEditor.hint.appearance":
		"Visual styling belongs in the Appearance panel.",
	"codeEditor.hint.interactions":
		"Event behavior belongs in the Interactions panel.",
	"codeEditor.hint.bindings": "Dynamic values belong in the Bindings panel.",
};

class GrammarError extends Error {
	readonly diagnostic: Diagnostic;

	constructor(diagnostic: Diagnostic) {
		super(diagnostic.message);
		this.name = "GrammarError";
		this.diagnostic = diagnostic;
	}
}

function asNode(value: unknown): AstNode | null {
	if (typeof value !== "object" || value === null) return null;
	const node = value as { readonly type?: unknown };
	return typeof node.type === "string" ? (value as AstNode) : null;
}

function nodes(value: unknown): readonly AstNode[] {
	return Array.isArray(value)
		? value.map(asNode).filter((node): node is AstNode => node !== null)
		: [];
}

function stringValue(node: AstNode | null, key: string): string | null {
	const value = node?.[key];
	return typeof value === "string" ? value : null;
}

function diagnostic(
	node: AstNode | null,
	message: string,
	hintKey: HintKey,
): Diagnostic {
	const start = node?.loc?.start;
	return {
		path: "",
		message: `${message} ${HINT_TEXT[hintKey]}`,
		line: start?.line ?? 1,
		col: (start?.column ?? 0) + 1,
		severity: "error",
		hintKey,
	};
}

function reject(
	node: AstNode | null,
	message: string,
	hintKey: HintKey,
): never {
	throw new GrammarError(diagnostic(node, message, hintKey));
}

function assertDepth(node: AstNode | null, depth: number): void {
	if (depth > MAX_PARSE_DEPTH) {
		reject(
			node,
			`TSX nesting exceeds the maximum depth of ${MAX_PARSE_DEPTH}.`,
			"codeEditor.hint.slots",
		);
	}
}

function fieldsOf(config: Config, type: string): Record<string, Field> {
	return (config.components?.[type]?.fields ?? {}) as Record<string, Field>;
}

function jsxNamePath(node: AstNode | null): readonly string[] {
	if (node?.type === "JSXIdentifier") {
		const name = stringValue(node, "name");
		return name === null ? [] : [name];
	}
	if (node?.type === "JSXMemberExpression") {
		return [
			...jsxNamePath(asNode(node.object)),
			...jsxNamePath(asNode(node.property)),
		];
	}
	return [];
}

function objectKey(node: AstNode | null): string | null {
	if (node?.type === "Identifier" || node?.type === "StringLiteral") {
		return stringValue(node, node.type === "Identifier" ? "name" : "value");
	}
	if (node?.type === "NumericLiteral" && typeof node.value === "number") {
		return String(node.value);
	}
	return null;
}

function expressionHint(node: AstNode, propName: string): HintKey {
	if (propName === "style" || propName === "className") {
		return "codeEditor.hint.appearance";
	}
	if (/^on[A-Z]/.test(propName)) return "codeEditor.hint.interactions";
	if (
		node.type === "ConditionalExpression" ||
		node.type === "LogicalExpression"
	) {
		return "codeEditor.hint.interactions";
	}
	return "codeEditor.hint.bindings";
}

function expressionLabel(node: AstNode): string {
	if (node.type === "Identifier")
		return "Identifiers are not writable TSX values.";
	if (
		node.type === "MemberExpression" ||
		node.type === "OptionalMemberExpression"
	) {
		return "Member expressions are not writable TSX values.";
	}
	if (
		node.type === "ConditionalExpression" ||
		node.type === "LogicalExpression"
	) {
		return "Conditional expressions are not part of the writable grammar.";
	}
	if (
		node.type === "CallExpression" ||
		node.type === "OptionalCallExpression"
	) {
		const callee = asNode(node.callee);
		const calleeName = stringValue(callee, "name");
		if (calleeName?.startsWith("use")) {
			return "Hooks are not allowed in document TSX.";
		}
		const property = asNode(asNode(callee?.property));
		if (stringValue(property, "name") === "map") {
			return "Loops and map expressions are not part of the writable grammar.";
		}
		return "Function calls are not writable TSX values.";
	}
	if (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionExpression"
	) {
		return "Functions and loops are not part of the writable grammar.";
	}
	return `Expression ${node.type} is not a literal writable value.`;
}

function parseLiteral(node: AstNode, propName: string, depth: number): unknown {
	assertDepth(node, depth);
	if (
		node.type === "StringLiteral" ||
		node.type === "NumericLiteral" ||
		node.type === "BooleanLiteral"
	) {
		return node.value;
	}
	if (node.type === "NullLiteral") return null;
	if (node.type === "UnaryExpression") {
		const operator = stringValue(node, "operator");
		const argument = asNode(node.argument);
		if (
			(operator === "-" || operator === "+") &&
			argument?.type === "NumericLiteral" &&
			typeof argument.value === "number"
		) {
			return operator === "-" ? -argument.value : argument.value;
		}
	}
	if (node.type === "ArrayExpression") {
		return (Array.isArray(node.elements) ? node.elements : []).map((value) => {
			const element = asNode(value);
			if (element === null || element.type === "SpreadElement") {
				reject(
					element ?? node,
					"Array holes and spreads are not writable literals.",
					expressionHint(node, propName),
				);
			}
			return parseLiteral(element, propName, depth + 1);
		});
	}
	if (node.type === "ObjectExpression") {
		const result: Record<string, unknown> = {};
		for (const property of nodes(node.properties)) {
			if (
				property.type !== "ObjectProperty" ||
				property.computed === true ||
				property.shorthand === true ||
				property.method === true
			) {
				reject(
					property,
					"Object spreads, methods, and computed keys are not writable literals.",
					expressionHint(property, propName),
				);
			}
			const key = objectKey(asNode(property.key));
			const value = asNode(property.value);
			if (key === null || value === null) {
				reject(
					property,
					"Object properties must use static keys and literal values.",
					expressionHint(property, propName),
				);
			}
			result[key] = parseLiteral(value, propName, depth + 1);
		}
		return result;
	}
	reject(node, expressionLabel(node), expressionHint(node, propName));
}

function parseAttributeValue(attribute: AstNode, propName: string): unknown {
	const value = asNode(attribute.value);
	if (value?.type === "StringLiteral") return value.value;
	if (value?.type === "JSXExpressionContainer") {
		const expression = asNode(value.expression);
		if (expression !== null) return parseLiteral(expression, propName, 1);
	}
	reject(
		value ?? attribute,
		"Attributes require an explicit string or brace-wrapped literal value.",
		"codeEditor.hint.fields",
	);
}

function designatedTextField(fields: Record<string, Field>): string | null {
	const textFields = Object.keys(fields).filter(
		(key) => fields[key]?.type === "text",
	);
	return textFields.length === 1 ? (textFields[0] ?? null) : null;
}

function parseSlotChildren(
	children: unknown,
	config: Config,
	depth: number,
): ParsedTsxNode[] {
	const result: ParsedTsxNode[] = [];
	for (const child of nodes(children)) {
		if (child.type === "JSXText" && !String(child.value ?? "").trim()) continue;
		if (child.type === "JSXElement") {
			const opening = asNode(child.openingElement);
			const path = jsxNamePath(asNode(opening?.name));
			if (path.length !== 1) {
				reject(
					child,
					"Slot tags must be direct children of their owning component.",
					"codeEditor.hint.slots",
				);
			}
			result.push(parseElement(child, config, depth));
			continue;
		}
		reject(
			child,
			"Slots may contain only whitelisted component elements.",
			"codeEditor.hint.slots",
		);
	}
	return result;
}

function applySlot(
	path: readonly string[],
	slotElement: AstNode,
	ownerType: string,
	fields: Record<string, Field>,
	props: Record<string, unknown>,
	seenSlots: Set<string>,
	config: Config,
	depth: number,
): void {
	const opening = asNode(slotElement.openingElement);
	if (nodes(opening?.attributes).length > 0) {
		reject(
			slotElement,
			"Slot tags cannot declare attributes.",
			"codeEditor.hint.slots",
		);
	}
	const key = path.join(".");
	if (seenSlots.has(key)) {
		reject(
			slotElement,
			`Slot ${key} is declared more than once.`,
			"codeEditor.hint.slots",
		);
	}
	seenSlots.add(key);
	const content = parseSlotChildren(slotElement.children, config, depth + 1);

	if (path.length === 2 && path[0] === ownerType) {
		const slotName = path[1] ?? "";
		if (fields[slotName]?.type !== "slot") {
			reject(
				slotElement,
				`${ownerType}.${slotName} is not a declared slot.`,
				"codeEditor.hint.slots",
			);
		}
		props[slotName] = content;
		return;
	}

	if (path.length === 4 && path[0] === ownerType) {
		const arrayName = path[1] ?? "";
		const encodedIndex = path[2] ?? "";
		const slotName = path[3] ?? "";
		const indexMatch = ARRAY_INDEX.exec(encodedIndex);
		const field = fields[arrayName];
		const itemFields = (field as { arrayFields?: Record<string, Field> })
			?.arrayFields;
		if (
			field?.type !== "array" ||
			indexMatch === null ||
			itemFields?.[slotName]?.type !== "slot"
		) {
			reject(
				slotElement,
				`${key} is not a declared array-item slot path.`,
				"codeEditor.hint.slots",
			);
		}
		const index = Number(indexMatch[1]);
		const items = props[arrayName];
		if (!Array.isArray(items) || index >= items.length) {
			reject(
				slotElement,
				`${key} references an item that is not present in the ${arrayName} literal.`,
				"codeEditor.hint.slots",
			);
		}
		const item = items[index];
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			reject(
				slotElement,
				`${arrayName}[${index}] must be an object before its slot can be assigned.`,
				"codeEditor.hint.slots",
			);
		}
		(item as Record<string, unknown>)[slotName] = content;
		return;
	}

	reject(
		slotElement,
		`${key} is not a valid slot path for ${ownerType}.`,
		"codeEditor.hint.slots",
	);
}

function requireDeclaredSlots(
	node: AstNode,
	type: string,
	fields: Record<string, Field>,
	props: Record<string, unknown>,
	seenSlots: Set<string>,
): void {
	for (const [fieldName, field] of Object.entries(fields)) {
		if (field.type === "slot" && !seenSlots.has(`${type}.${fieldName}`)) {
			reject(
				node,
				`Declared slot ${type}.${fieldName} must have one explicit slot tag.`,
				"codeEditor.hint.slots",
			);
		}
		if (field.type !== "array" || !Array.isArray(props[fieldName])) continue;
		const itemFields = (field as { arrayFields?: Record<string, Field> })
			.arrayFields;
		if (!itemFields) continue;
		for (let index = 0; index < props[fieldName].length; index += 1) {
			for (const [itemFieldName, itemField] of Object.entries(itemFields)) {
				const path = `${type}.${fieldName}.i${index}.${itemFieldName}`;
				if (itemField.type === "slot" && !seenSlots.has(path)) {
					reject(
						node,
						`Declared slot ${path} must have one explicit slot tag.`,
						"codeEditor.hint.slots",
					);
				}
			}
		}
	}
}

function parseElement(
	element: AstNode,
	config: Config,
	depth: number,
): ParsedTsxNode {
	assertDepth(element, depth);
	const opening = asNode(element.openingElement);
	const path = jsxNamePath(asNode(opening?.name));
	if (path.length !== 1) {
		reject(
			element,
			"Member tags are reserved for declared slots.",
			"codeEditor.hint.slots",
		);
	}
	const type = path[0] ?? "";
	const component = config.components?.[type];
	if (!component) {
		reject(
			element,
			`Component ${type || "<unknown>"} is not in the editor whitelist.`,
			"codeEditor.hint.fields",
		);
	}

	const fields = fieldsOf(config, type);
	const props: Record<string, unknown> = {};
	let akId: string | undefined;
	const seenProps = new Set<string>();

	for (const attribute of nodes(opening?.attributes)) {
		if (attribute.type === "JSXSpreadAttribute") {
			reject(
				attribute,
				"Spread attributes are not part of the writable grammar.",
				"codeEditor.hint.bindings",
			);
		}
		if (attribute.type !== "JSXAttribute") {
			reject(
				attribute,
				"Only named attributes are allowed.",
				"codeEditor.hint.fields",
			);
		}
		const nameNode = asNode(attribute.name);
		const propName =
			nameNode?.type === "JSXIdentifier" ? stringValue(nameNode, "name") : null;
		if (propName === null) {
			reject(
				attribute,
				"Attribute names must be identifiers.",
				"codeEditor.hint.fields",
			);
		}
		if (seenProps.has(propName)) {
			reject(
				attribute,
				`Attribute ${propName} is declared more than once.`,
				"codeEditor.hint.fields",
			);
		}
		seenProps.add(propName);
		if (propName === "akId") {
			const valueNode = asNode(attribute.value);
			if (
				valueNode?.type !== "StringLiteral" ||
				typeof valueNode.value !== "string" ||
				valueNode.value.length === 0
			) {
				reject(
					attribute,
					"akId must be a non-empty string literal.",
					"codeEditor.hint.fields",
				);
			}
			akId = valueNode.value;
			continue;
		}
		if (/^on[A-Z]/.test(propName) || propName === "interactions") {
			reject(
				attribute,
				`Event attribute ${propName} is not writable TSX.`,
				"codeEditor.hint.interactions",
			);
		}
		if (
			propName === "style" ||
			propName === "className" ||
			propName === "appearance"
		) {
			reject(
				attribute,
				`Visual attribute ${propName} is not writable TSX.`,
				"codeEditor.hint.appearance",
			);
		}
		if (propName === "bindings") {
			reject(
				attribute,
				"Binding carriers are not projected into writable TSX.",
				"codeEditor.hint.bindings",
			);
		}
		const field = fields[propName];
		if (!field) {
			reject(
				attribute,
				`Prop ${type}.${propName} is not declared by the component config.`,
				"codeEditor.hint.fields",
			);
		}
		if (field.type === "slot") {
			reject(
				attribute,
				`Slot ${type}.${propName} must use an explicit member tag.`,
				"codeEditor.hint.slots",
			);
		}
		props[propName] = parseAttributeValue(attribute, propName);
	}

	const seenSlots = new Set<string>();
	const textParts: string[] = [];
	for (const child of nodes(element.children)) {
		if (child.type === "JSXText") {
			const value = String(child.value ?? "").trim();
			if (value) textParts.push(value);
			continue;
		}
		if (child.type === "JSXElement") {
			const childOpening = asNode(child.openingElement);
			const childPath = jsxNamePath(asNode(childOpening?.name));
			if (childPath.length === 1) {
				reject(
					child,
					"Nested components must be wrapped in an explicit declared slot tag.",
					"codeEditor.hint.slots",
				);
			}
			applySlot(
				childPath,
				child,
				type,
				fields,
				props,
				seenSlots,
				config,
				depth,
			);
			continue;
		}
		if (child.type === "JSXExpressionContainer") {
			const expression = asNode(child.expression);
			if (expression !== null) {
				reject(
					expression,
					expressionLabel(expression),
					expressionHint(expression, "children"),
				);
			}
		}
		reject(
			child,
			"Only explicit slots or designated text are allowed as children.",
			"codeEditor.hint.slots",
		);
	}

	if (textParts.length > 0) {
		const textField = designatedTextField(fields);
		if (textField === null) {
			reject(
				element,
				"JSX text requires exactly one designated text field.",
				"codeEditor.hint.fields",
			);
		}
		if (seenProps.has(textField)) {
			reject(
				element,
				`Text field ${type}.${textField} cannot be set by both an attribute and JSX text.`,
				"codeEditor.hint.fields",
			);
		}
		props[textField] = textParts.join(" ");
	}

	requireDeclaredSlots(element, type, fields, props, seenSlots);
	return { type, ...(akId === undefined ? {} : { akId }), props };
}

function parseRoot(expression: AstNode, config: Config): ParsedTsxDocument {
	const content: ParsedTsxNode[] = [];
	if (expression.type === "JSXElement") {
		content.push(parseElement(expression, config, 1));
		return { content };
	}
	if (expression.type !== "JSXFragment") {
		reject(
			expression,
			"The default Page function must return a JSX fragment or component element.",
			"codeEditor.hint.fields",
		);
	}
	for (const child of nodes(expression.children)) {
		if (child.type === "JSXText" && !String(child.value ?? "").trim()) continue;
		if (child.type !== "JSXElement") {
			reject(
				child,
				"The document root may contain only whitelisted component elements.",
				"codeEditor.hint.fields",
			);
		}
		content.push(parseElement(child, config, 1));
	}
	return { content };
}

function returnExpression(file: AstNode): AstNode {
	const program = asNode(file.program);
	const body = nodes(program?.body);
	if (body.length !== 1 || body[0]?.type !== "ExportDefaultDeclaration") {
		reject(
			body[0] ?? program,
			"TSX must contain only one default-exported Page function.",
			"codeEditor.hint.fields",
		);
	}
	const declaration = asNode(body[0]?.declaration);
	const id = asNode(declaration?.id);
	if (
		declaration?.type !== "FunctionDeclaration" ||
		stringValue(id, "name") !== "Page" ||
		declaration.async === true ||
		declaration.generator === true ||
		nodes(declaration.params).length > 0
	) {
		reject(
			declaration,
			"The default export must be a synchronous parameterless function named Page.",
			"codeEditor.hint.fields",
		);
	}
	const block = asNode(declaration.body);
	const statements = nodes(block?.body);
	if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") {
		const hook = statements.find((statement) => {
			const declarationNode = nodes(statement.declarations)[0];
			const init = asNode(declarationNode?.init);
			const callee = asNode(init?.callee);
			return (
				init?.type === "CallExpression" &&
				stringValue(callee, "name")?.startsWith("use")
			);
		});
		if (hook) {
			reject(
				hook,
				"Hooks are not allowed in document TSX.",
				"codeEditor.hint.bindings",
			);
		}
		reject(
			statements[0] ?? block,
			"Page must contain exactly one return statement and no executable code.",
			"codeEditor.hint.bindings",
		);
	}
	const expression = asNode(statements[0]?.argument);
	if (expression === null) {
		reject(
			statements[0] ?? block,
			"Page must return the document JSX.",
			"codeEditor.hint.fields",
		);
	}
	return expression;
}

function syntaxDiagnostic(error: unknown): Diagnostic {
	const candidate =
		typeof error === "object" && error !== null
			? (error as { message?: unknown; loc?: unknown })
			: {};
	const position =
		typeof candidate.loc === "object" && candidate.loc !== null
			? (candidate.loc as { line?: unknown; column?: unknown })
			: {};
	return {
		path: "",
		message: `${typeof candidate.message === "string" ? candidate.message : String(error)} ${HINT_TEXT["codeEditor.hint.fields"]}`,
		line: typeof position.line === "number" ? position.line : 1,
		col: typeof position.column === "number" ? position.column + 1 : 1,
		severity: "error",
		hintKey: "codeEditor.hint.fields",
	};
}

/**
 * Parse untrusted TSX without evaluating it, then enforce grammar v1 over
 * Babel's AST. Failure returns diagnostics only; no partial document escapes.
 */
export function parseTsx(
	text: string,
	config: Config,
): ApplyResult<ParsedTsxDocument> {
	try {
		const file = parse(text, {
			sourceType: "module",
			plugins: ["typescript", "jsx"],
			errorRecovery: true,
			attachComment: false,
		});
		if (file.errors && file.errors.length > 0) {
			return { ok: false, diagnostics: file.errors.map(syntaxDiagnostic) };
		}
		return {
			ok: true,
			value: parseRoot(returnExpression(file as unknown as AstNode), config),
		};
	} catch (error) {
		if (error instanceof GrammarError) {
			return { ok: false, diagnostics: [error.diagnostic] };
		}
		return { ok: false, diagnostics: [syntaxDiagnostic(error)] };
	}
}
