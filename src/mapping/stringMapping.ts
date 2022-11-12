import {MappingBase} from "./mappingBase";
import {MappingModel} from "./mappingModel";
import {ReadContext} from "./readContext";
import {WriteContext} from "./writeContext";

/**
 * @hidden
 */
export class StringMapping extends MappingBase {

    constructor() {
        super(MappingModel.MappingFlags.String);
    }

    read(context: ReadContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "string") {
            context.addError("Expected string.");
            return;
        }
        return value;
    }

    write(context: WriteContext, value: any): any {

        if(value == null) return null;

        if(typeof value !== "string") {
            context.addError("Expected string.");
            return;
        }
        return value;
    }
}
