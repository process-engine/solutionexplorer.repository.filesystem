import {BadRequestError, InternalServerError, NotFoundError} from '@essential-projects/errors_ts';
import {IIdentity} from '@essential-projects/iam_contracts';
import {IDiagram, ISolution} from '@process-engine/solutionexplorer.contracts';
import {ISolutionExplorerRepository} from '@process-engine/solutionexplorer.repository.contracts';

import * as fs from 'fs';
import * as path from 'path';
import {promisify} from 'util';

const BPMN_FILE_SUFFIX: string = '.bpmn';

export class SolutionExplorerFileSystemRepository implements ISolutionExplorerRepository {

  private _trashFolder: string;
  private _basePath: string;
  private _identity: IIdentity;

  private _readDirectory: (path: fs.PathLike) => Promise<Array<string>> = promisify(fs.readdir);
  private _readFile: (path: fs.PathLike, encoding: string) => Promise<string> = promisify(fs.readFile);
  private _writeFile: (path: fs.PathLike, data: any) => Promise<void> = promisify(fs.writeFile);
  private _rename: (oldPath: fs.PathLike, newPath: fs.PathLike) => Promise<void> = promisify(fs.rename);

  constructor(trashFolder: string) {
    this._trashFolder = trashFolder;
  }

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
      .map(async(file: string) => {

        const fullPathToFile: string = path.join(this._basePath, file);
        const fileNameWithoutBpmnSuffix: string = path.basename(file, BPMN_FILE_SUFFIX);

        const xml: string = await this._readFile(fullPathToFile, 'utf8');

        const diagram: IDiagram = {
          name: fileNameWithoutBpmnSuffix,
          uri: fullPathToFile,
          xml: xml,
        };

        return diagram;
    });

    return Promise.all(diagrams);
  }

  public async openSingleDiagram(fullPathToDiagram: string, identity: IIdentity): Promise<IDiagram> {
    const xml: string = await this._readFile(fullPathToDiagram, 'utf8');
    const diagramName: string = path.basename(fullPathToDiagram, BPMN_FILE_SUFFIX);

    const diagram: IDiagram = {
      name: diagramName,
      uri: fullPathToDiagram,
      xml: xml,
    };

    return diagram;
  }

  public async saveSingleDiagram(diagramToSave: IDiagram, identity: IIdentity, pathToSave?: string): Promise<IDiagram> {
    const newPathIsSet: boolean = pathToSave !== null && pathToSave !== undefined;
    let pathToWrite: string = diagramToSave.uri;

    if (newPathIsSet) {
      pathToWrite = pathToSave;
    }

    await this._checkWriteablity(pathToWrite);

    try {
      this._writeFile(pathToWrite, diagramToSave.xml);

      return diagramToSave;
    } catch (e) {
      const error: InternalServerError = new InternalServerError('Unable to save diagram.');
      error.additionalInformation = e;
      throw error;
    }
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

  public async saveSolution(solution: ISolution, pathToSolution?: string): Promise<void> {
    const newPathWasSet: boolean = pathToSolution !== undefined && pathToSolution !== null;

    if (newPathWasSet) {
      await this.openPath(pathToSolution, this._identity);
    }

    const promises: Array<Promise<void>> = solution.diagrams.map((diagram: IDiagram) => {
      return this.saveDiagram(diagram);
    });

    await Promise.all(promises);
  }

  public async deleteDiagram(diagram: IDiagram): Promise<void> {
    try {
      await this._checkForDirectory(this._trashFolder);
    } catch (error) {
      throw new BadRequestError('Trash folder is not writeable.');
    }

    const orginalTargetFile: string = path.join(this._trashFolder, diagram.name + BPMN_FILE_SUFFIX);
    let targetFile: string = orginalTargetFile;

    let fileAlreadyExists: boolean = fs.existsSync(targetFile);
    let attemptCount: number = 1;

    // If the target file is already there, find another name for the dleted diagram.
    while (fileAlreadyExists) {
      fileAlreadyExists = fs.existsSync(targetFile);

      targetFile = `${orginalTargetFile}.${attemptCount}`;
      attemptCount++;
    }

    await this._rename(diagram.uri, targetFile);
  }

  public async renameDiagram(diagram: IDiagram, newName: string): Promise<IDiagram> {
    const nameWithSuffix: string = newName + BPMN_FILE_SUFFIX;
    const newDiagramUri: string = path.join(this._basePath, nameWithSuffix);

    await this._checkWriteablity(newDiagramUri);

    const fileAlreadyExists: boolean = fs.existsSync(newDiagramUri);
    if (fileAlreadyExists) {
      throw new BadRequestError(`A file with the name ${newDiagramUri} already exists.`);
    }

    await this._rename(diagram.uri, newDiagramUri);

    const renamedDiagram: IDiagram = await this.getDiagramByName(newName);

    return renamedDiagram;
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
