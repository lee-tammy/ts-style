/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as fs from 'fs';
import * as path from 'path';
import {Options} from './cli';
import {createProgram} from './lint';
import { promisify } from 'util';

// Exported for testing purposes.
export const clangFormat = require('clang-format');
export const xml2js = require('xml2js');

const BASE_ARGS_FILE = ['-style=file'];
const BASE_ARGS_INLINE =
    ['-style', '{Language: JavaScript, BasedOnStyle: Google, ColumnLimit: 80}'];

/**
 * Run tslint fix and clang fix with the default configuration
 * @param options
 * @param fix whether to automatically fix the format
 * @param files files to format
 */
export async function format(
    options: Options, files: string[] = [], fix = false): Promise<boolean> {
    
  if (options.dryRun && fix) {
    options.logger.log('format: skipping auto fix since --dry-run was passed');
    fix = false;
  }

  // If the project has a .clang-format – use it. Else use the default as an
  // inline argument.
  const baseClangFormatArgs =
      fs.existsSync(path.join(options.targetRootDir, '.clang-format')) ?
      BASE_ARGS_FILE :
      BASE_ARGS_INLINE;

  const program = createProgram(options);
  // Obtain a list of source files to format.
  // We use program.getRootFileNames to get only the files that match the
  // include patterns specified in the given tsconfig.json file (as specified
  // through options). This is necessary because we only want to format files
  // over which the developer has control (i.e. not auto-generated or
  // third-party source files).
  const srcFiles = files.length > 0 ?
      files :
      program.getRootFileNames().filter(f => !f.endsWith('.d.ts'));

  if (fix) {
    return fixFormat(srcFiles, baseClangFormatArgs);
  } else {
    const result = await checkFormat(srcFiles, baseClangFormatArgs);
    if (!result) {
      options.logger.log(
          'clang-format reported errors... run `gts fix` to address.');
    }
    return result;
  }
}

/**
 * Runs clang-format to automatically fix the format of supplied files.
 *
 * @param srcFiles list of source files
 */
function fixFormat(srcFiles: string[], baseArgs: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const args = baseArgs.concat(['-i'], srcFiles);
    clangFormat.spawnClangFormat(args, (err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    }, 'inherit');
  });
}

/**
 * Runs clang-format on the list of files and checks whether they are formatted
 * correctly. Returns true if all files are formatted correctly.
 *
 * @param srcFiles list of source files
 */
function checkFormat(srcFiles: string[], baseArgs: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let output = '';
    const arrOffset: number[] = [];
    const arrOffsetLength: number[] = [];
    const args = baseArgs.concat(['-output-replacements-xml'], srcFiles);
    const out = clangFormat
                    .spawnClangFormat(
                        args,
                        (err?: Error) => {
                          if (err) {
                            reject(err);
                          }
                        },
                        ['ignore', 'pipe', process.stderr])
                    .stdout; 
    out.setEncoding('utf8');
    out.on('data', (data: Buffer) => {
      output += data;         
      
    });
    
    out.on('end', () => {
      findFormatErrorLines(output)
        .then(() => {
          resolve(output.indexOf('<replacement ') === -1 ? true : false);
        });
    });
  });
}

/**
 * Parses through xml string for the replacement offsets and lengths. Uses those values
 * to locate the formatting error lines.
 * 
 * @param output xml string 
 */
async function findFormatErrorLines(output: string){
  const parser = new xml2js.Parser();
  const files = output.split('<?xml version=\'1.0\'?>\n');

  for(let i = 1; i < files.length; i++){

    let arrOffset: number[] = [];
    let arrOffsetLength: number[] = [];

    parser.parseString(files[i], function(err: any, xmlOutput: any){
      if(err){
        throw err;
      }
    
      if(xmlOutput['replacements']['replacement'] === undefined){
        return;
      }

      let j = 0;
      while(xmlOutput['replacements']['replacement'][j] !== undefined){
        arrOffset[j] = xmlOutput['replacements']['replacement'][j].$.offset;
        arrOffsetLength[j] = xmlOutput['replacements']['replacement'][j].$.length;
        j++;  
      }
    });

    const buffer = '';
    let lines: string[] = [];
    const read = promisify(fs.readFile);
    const argNum = 3;
    const file = process.argv[argNum + i - 1];

    const data = await read(file, 'utf8');
    lines = data.split('\n');

    let lineCount = 0;
    let prevCharCount = 0;
    for(let i = 0; i < arrOffset.length;){
      if(arrOffset[i] < prevCharCount + +lines[lineCount].length){
        printFormatErrLines(lines[lineCount], arrOffset[i] - +prevCharCount, 
            arrOffsetLength[i], lineCount + 1, file);
        i++;  
      }else{
        prevCharCount += +lines[lineCount].length + +1;
        lineCount++;
      }
    }
  }
}


/**
 * Prints the line with formatting issues.
 * 
 * @param line string in file with formatting issue
 * @param pos position of the start of formatting issue
 * @param length the length of the formatting issue
 * @param lineNumber 
 * @param file the file where formatting issue is
 */
function printFormatErrLines(line: string, pos: number, length: number, 
    lineNumber: number, file: string){
  const header = file + ':' + lineNumber;
  const spacing = header.length + 3;
  process.stdout.write(header);
  console.log(' '.repeat(3) + line);
  process.stdout.write(' '.repeat(spacing));
  for(let i = 0; i < line.length; i++){
    if(i >= pos && i < (+pos + +length)){
      process.stdout.write('^');
    }else{
      process.stdout.write('-');
    }
  }
  console.log();
}
