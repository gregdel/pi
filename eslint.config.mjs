import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const unusedVariables = {
	argsIgnorePattern: "^_",
	caughtErrorsIgnorePattern: "^_",
};

export default defineConfig(
	{
		files: ["extensions/**/*.ts", "tests/**/*.mjs", "eslint.config.mjs"],
		extends: [js.configs.recommended],
		languageOptions: { globals: globals.node },
		rules: {
			"no-unused-vars": ["error", unusedVariables],
		},
	},
	{
		files: ["extensions/**/*.ts"],
		extends: [tseslint.configs.recommended],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", unusedVariables],
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},
);
