import {ISolutionExplorerRepository} from 'solutionexplorer.repository.contracts';
import {BadRequestError, InternalServerError, NotFoundError} from '@essential-projects/errors_ts';
import {IIdentity} from '@essential-projects/core_contracts';
import {IDiagram, ISolution} from 'solutionexplorer.contracts';

import * as fs from 'fs';
import * as path from 'path';
import {promisify} from 'util';

const BPMN_FILE_SUFFIX: string = '.bpmn';

export class SolutionExplorerFileSystemRepository implements ISolutionExplorerRepository {

  private _basePath: string;
  private _identity: IIdentity;

  private _readDirectory = promisify(fs.readdir);
  private _readFile = promisify(fs.readFile);
  private _writeFile = promisify(fs.writeFile);

  public async openPath(pathspec: string, identity: IIdentity): Promise<void> {
    await this._checkForDirectory(pathspec);

    this._basePath = pathspec;
    this._identity = identity;
  }

  public async getDiagrams(): Promise<Array<IDiagram>> {
    const filesInDirectory: Array<string> = await this._readDirectory(this._basePath);
    const bpmnFiles: Array<string> = [];

    for (const file of filesInDirectory) {
      if (file.endsWith(BPMN_FILE_SUFFIX)) {
        bpmnFiles.push(file);
      }
    }

    const diagrams: Array<Promise<IDiagram>> = bpmnFiles
      .map(async (file: string) => {

        const fullPathToFile: string = path.join(this._basePath, file);
        const fileNameWithoutBpmnSuffix = file.substr(0, file.length - BPMN_FILE_SUFFIX.length);

        const xml: string = await this._readFile(fullPathToFile, 'utf8');

        const diagram: IDiagram = {
          name: fileNameWithoutBpmnSuffix,
          uri: fullPathToFile,
          xml: xml
        };

        return diagram;
    });

    return Promise.all(diagrams);
  }

  public async getDiagramByName(diagramName: string): Promise<IDiagram> {
    const fullPathToFile: string = path.join(this._basePath, `${diagramName}.bpmn`);

    const xml: string = await this._readFile(fullPathToFile, 'utf8');

    const diagram: IDiagram = {
      name: diagramName,
      uri: fullPathToFile,
      xml: xml,
      id: fullPathToFile,
    };

    return diagram;
  }

  public async saveDiagram(diagramToSave: IDiagram, newPathSpec?: string): Promise<void> {
    const newPathSpecWasSet: boolean = newPathSpec !== null && newPathSpec !== undefined;
    let pathToWriteDiagram: string;

    if (newPathSpecWasSet) {

      pathToWriteDiagram = newPathSpec;

    } else {
      const expectedUriForDiagram: string = path.join(this._basePath, `${diagramToSave.name}.bpmn`);

      const uriOfDiagramWasChanged: boolean = expectedUriForDiagram !== diagramToSave.uri;
      if (uriOfDiagramWasChanged) {
        throw new BadRequestError('Target Location (URI) of diagram was changed; Moving a diagram is currently not supported.');
      }

      pathToWriteDiagram = diagramToSave.uri;
    }

    await this._checkWriteablity(pathToWriteDiagram);

    try {
      await this._writeFile(pathToWriteDiagram, diagramToSave.xml);
    } catch (e) {
      const error: InternalServerError = new InternalServerError('Unable to save diagram.');
      error.additionalInformation = e;
      throw error;
    }
  }

  public async saveSolution(solution: ISolution, path?: string): Promise<void> {
    const newPathWasSet: boolean = path !== undefined && path !== null;

    if (newPathWasSet) {
      await this.openPath(path, this._identity);
    }

    const promises: Array<Promise<void>> = solution.diagrams.map((diagram: IDiagram) => {
      return this.saveDiagram(diagram);
    });

    await Promise.all(promises);
  }

  private async _checkForDirectory(directoryPath: string): Promise<void> {
    const pathDoesNotExist: boolean = !fs.existsSync(directoryPath);
    if (pathDoesNotExist) {
      throw new NotFoundError(`'${directoryPath}' does not exist.`);
    }

    const stat: fs.Stats = fs.statSync(directoryPath);
    const pathIsNotADirectory: boolean = !stat.isDirectory();
    if (pathIsNotADirectory) {
      throw new BadRequestError(`'${directoryPath}' is not a directory.`);
    }
  }

  private async _checkWriteablity(filePath: string): Promise<void> {
    const directoryPath: string = path.dirname(filePath);

    await this._checkForDirectory(directoryPath);
  }
}
