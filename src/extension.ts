import * as vscode from 'vscode';
import { Configuration, OpenAIApi } from 'openai';
import * as ts from 'typescript';

function displaySuggestion(suggestion: string) {
  const panel = vscode.window.createWebviewPanel(
    'openaiSuggestion', // Identifies the type of the webview. Used internally.
    'OpenAI Suggestion', // Title of the panel displayed to the user.
    vscode.ViewColumn.One, // Show the new webview in a new editor column.
    {} // Webview options. No options for now.
  );

  // Set the content of the WebView using the suggestion text.
  panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>OpenAI Suggestion</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif;
          margin: 20px;
          line-height: 1.6;
          font-size: 16px;
          color: white;
        }
      </style>
    </head>
    <body>
      <h1>Suggested Solution</h1>
      <h1>${suggestion}</h1>
    </body>
    </html>
  `;
}


async function getOpenAISuggestion(error: string, codeSnippet: string, apiKey: string, lineSnippet: string): Promise<string> {
  const configuration = new Configuration({
    apiKey,
  });

  try {
    console.log(error, codeSnippet, lineSnippet)
    const openai = new OpenAIApi(configuration);
    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: `Act as a TypeScript engineer. You received the following error: ${error}. This is the line that it is thrown from: ${lineSnippet}. Here is the surrounding code with the snippet I pasted included: ${codeSnippet}. Explain the error with better detail from the context.`,
        }
      ],
      max_tokens: 1000,
      n: 1,
      temperature: 0.5,
    });
    const suggestion = response?.data?.choices[0]?.message?.content ||  ''
    return suggestion;
  } catch (err){
    console.log(err)
  }
  return ''
}


function getErrorMessageForLine(line: number, diagnostics: readonly ts.Diagnostic[]): string | undefined {
  for (const diagnostic of diagnostics) {
    const { line: errorLine } = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!)
      : { line: 0 };

    if (errorLine === line) {
      return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    }
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
	try {
		let disposable = vscode.commands.registerCommand('extension.getTsErrors', async () => {
			const activeEditor = vscode.window.activeTextEditor;
	
			if (!activeEditor) {
				vscode.window.showErrorMessage('No active editor found.');
				return;
			}
	
			if (activeEditor.document.languageId !== 'typescript') {
				vscode.window.showErrorMessage('This command only works with TypeScript files.');
				return;
			}
	
			const tsErrors = await getTypescriptErrors(activeEditor.document, context);
	
			if (tsErrors.length === 0) {
				vscode.window.showInformationMessage('No TypeScript errors found.');
			} else {
				vscode.window.showErrorMessage(`Found ${tsErrors.length} TypeScript errors.`);
				console.log(1, tsErrors);
			}
		});
	  let storeApiKeyDisposable = vscode.commands.registerCommand('extension.storeApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your API Key',
        password: true,
      });
  
      if (apiKey) {
        await context.secrets.store('apiKey', apiKey);
        vscode.window.showInformationMessage('API Key stored successfully.');
      } else {
        vscode.window.showErrorMessage('No API Key provided.');
      }
    });
  
    context.subscriptions.push(storeApiKeyDisposable);
		context.subscriptions.push(disposable);
	} catch (err) {
		console.log(1, err);
	}

}
async function getTypeScriptPackage(): Promise<typeof ts | undefined> {
  const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
  
  if (!tsExtension) {
    vscode.window.showErrorMessage('TypeScript Language Features extension not found.');
    return undefined;
  }

  // Activate the TypeScript extension and get the exported API
  const api = await tsExtension.activate();
  return api.getTypeScriptApi();
}

async function getTypescriptErrors(document: vscode.TextDocument, context: vscode.ExtensionContext): Promise<any> {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showErrorMessage('No workspace folder is open.');
    return [];
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const tsConfigFile = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');

  if (!tsConfigFile) {
    vscode.window.showErrorMessage('No tsconfig.json file found in the workspace.');
    return [];
  }

  const config = ts.readConfigFile(tsConfigFile, ts.sys.readFile);
  const parseConfigHost: ts.ParseConfigHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    useCaseSensitiveFileNames: true,
  };

  const parsed = ts.parseJsonConfigFileContent(config.config, parseConfigHost, workspaceRoot, { noEmit: true });
  const program = ts.createProgram([document.fileName], parsed.options);

  // Get the SourceFile object for the active document
  const sourceFile = program.getSourceFile(document.fileName);
  if (!sourceFile) {
    vscode.window.showErrorMessage('Failed to retrieve the SourceFile object.');
    return [];
  }

  const diagnostics = program.getSemanticDiagnostics(sourceFile);

  const errorLines = diagnostics.map((diagnostic) => {
    const {line, character} = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!)
      : {line: 0, character: 0};
    const error = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    return {
      label: `Line ${line + 1}: ${error}`,
      line: line,
      character: character,
      error: error,
    };
  });

  const selectedErrorLine = await vscode.window.showQuickPick(errorLines, {
    placeHolder: 'Select an error line to get a suggestion from OpenAI',
  });

  if (selectedErrorLine) {
    const errorMessage = getErrorMessageForLine(selectedErrorLine.line, diagnostics);

    if (errorMessage) {

      const apiKey = await context.secrets.get('apiKey');
      if (!apiKey) {
        vscode.window.showErrorMessage('API Key not found. Please store your API Key first.');
        return;
      }
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }
    

      const document = activeEditor.document;
      // Use the error message in any way you want
      console.log(`Error message for line ${selectedErrorLine.line + 1}: ${errorMessage}`);
      const codeSnippet = document.lineAt(selectedErrorLine.line).text;
      const fileContent = document.getText();
      console.log('calling')
      const suggestion = await getOpenAISuggestion(errorMessage, codeSnippet, apiKey, fileContent);
      displaySuggestion(suggestion)
    } else {
      vscode.window.showErrorMessage('No error found on the selected line.');
    }
  }

  return diagnostics;
}
