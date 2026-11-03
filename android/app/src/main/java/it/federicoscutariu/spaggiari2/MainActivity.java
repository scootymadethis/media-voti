package it.federicoscutariu.spaggiari2;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin locale per il login SPID/CIE su ClasseViva (va registrato prima di super.onCreate).
        registerPlugin(SpaggiariLoginPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
